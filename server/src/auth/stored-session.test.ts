import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { authenticateStoredSession, createRequireStoredUserSession } from './stored-session.js';
import { hashSessionToken } from './session.js';
import { serializeSessionCookie } from './cookie.js';
import type { RelayEnv } from './authorization.js';

const token = 'synthetic-auth-session';
const tokenHash = hashSessionToken(token);
const cookie = serializeSessionCookie(token, Date.now() + 60_000, false);

test('Worker authentication returns a public projection and sees role, expiry and revocation changes immediately', async () => {
  const f = fixture(); f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${tokenHash}','owner',${Date.now() + 60_000})`);
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  try {
    const session = await authenticateStoredSession(token, port);
    assert.equal(session?.user.id, 'owner'); assert.equal(session?.tokenHash, tokenHash);
    assert.equal(JSON.stringify(session).includes('password_hash'), false);
    assert.equal(JSON.stringify(session).includes('avatar_data'), false);
    f.mutate("UPDATE users SET role='admin',must_change_password=1 WHERE id='owner'");
    const changed = await authenticateStoredSession(token, port);
    assert.equal(changed?.user.role, 'admin'); assert.equal(changed?.user.mustChangePassword, true);
    f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");
    assert.equal(await authenticateStoredSession(token, port), null);
    f.mutate("UPDATE users SET disabled_at=NULL WHERE id='owner'; UPDATE auth_sessions SET expires_at=0");
    assert.equal(await authenticateStoredSession(token, port), null);
    f.mutate(`UPDATE auth_sessions SET expires_at=${Date.now() + 60_000}; DELETE FROM auth_sessions WHERE token_hash='${tokenHash}'`);
    assert.equal(await authenticateStoredSession(token, port), null);
    await assert.rejects(port.authenticateSession({ tokenHash: 'raw-token' }), /INVALID_ARGUMENT/);
    assert.equal(await authenticateStoredSession(null, port), null);
  } finally { await port.close(); f.cleanup(); }
});

test('real Hono middleware awaits authentication, gates password change and distinguishes storage outage from logout', async () => {
  const f = fixture(); f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${tokenHash}','owner',${Date.now() + 60_000})`);
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  const app = new Hono<RelayEnv>();
  app.use('/api/*', createRequireStoredUserSession(port));
  app.get('/api/private', (c) => {
    const actor = c.get('relayActor'); const principal = c.get('relayStoragePrincipal');
    assert.equal(principal?.kind, 'user'); assert.equal(principal?.userId, actor.userId);
    assert.equal(principal?.authSessionHash, tokenHash);
    return c.json({ userId: actor.userId });
  });
  app.get('/api/auth/me', (c) => c.json({ userId: c.get('relayActor').userId }));
  const request = (url = '/api/private') => app.request(url, { headers: { cookie } });
  try {
    assert.equal((await app.request('/api/private')).status, 401);
    const valid = await request(); assert.equal(valid.status, 200); assert.deepEqual(await valid.json(), { userId: 'owner' });
    f.mutate("UPDATE users SET must_change_password=1 WHERE id='owner'");
    assert.equal((await request()).status, 403); assert.equal((await request('/api/auth/me')).status, 200);
    f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");
    assert.equal((await request()).status, 401);
    await port.close();
    const outage = await request(); assert.equal(outage.status, 503);
    assert.equal((await outage.json() as { code: string }).code, 'STORAGE_UNAVAILABLE');
  } finally { await port.close(); f.cleanup(); }
});
