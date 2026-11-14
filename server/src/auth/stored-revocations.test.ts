import test from 'node:test';
import assert from 'node:assert/strict';
import { StoredAuthRevocations, type StoredAuthClient } from './stored-revocations.js';
import { LoginIntentTokens } from './login-intents.js';

test('login token custody is bounded, context-bound, expiring and disposable', () => {
  let now = 0; const held = new LoginIntentTokens(1, 1000, () => now);
  try {
    const first = held.acquire('one', 'client');
    assert.deepEqual(Object.keys(first).sort(), ['token', 'tokenHash']);
    assert.equal(held.acquire('one', 'client').token, first.token);
    assert.throws(() => held.acquire('one', 'different-client'), /CONFLICT/);
    assert.throws(() => held.acquire('two', 'client'), /OVERLOADED/);
    now = 1001; assert.notEqual(held.acquire('one', 'client').token, first.token); assert.equal(held.size, 1);
    held.dispose(); assert.equal(held.size, 0); assert.throws(() => held.acquire('new', 'client'), /STORAGE_UNAVAILABLE/);
  } finally { held.dispose(); }
});

test('token replacement during async authority lookup fences an old connection revocation', async () => {
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>((done) => { release = done; }); const pending = new Promise<void>((done) => { started = done; });
  let revoked = false;
  const client: StoredAuthClient = { userId: 'user', tokenHash: 'old', isCurrent: () => true,
    revoke: () => { revoked = true; }, refresh: () => assert.fail('stale callback') };
  const bridge = new StoredAuthRevocations({ authenticateSession: async () => { started(); await gate; return null; } }, () => [client]);
  const result = bridge.recheckUser('user'); await pending; client.tokenHash = 'new'; release(); await result;
  assert.equal(revoked, false);
});

test('storage outage cannot be mistaken for revoked authority and a later recheck remains possible', async () => {
  let outage = true; let revoked = 0;
  const client: StoredAuthClient = { userId: 'user', tokenHash: 'token', isCurrent: () => true, revoke: () => { revoked++; }, refresh: () => undefined };
  const bridge = new StoredAuthRevocations({ authenticateSession: async () => { if (outage) throw new Error('synthetic outage'); return null; } }, () => [client]);
  await assert.rejects(bridge.recheckUser('user'), /synthetic outage/); assert.equal(revoked, 0);
  outage = false; await bridge.recheckUser('user'); assert.equal(revoked, 1);
});
