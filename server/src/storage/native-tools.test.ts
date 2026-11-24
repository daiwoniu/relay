import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { fixture } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import type { StorageCommandEnvelope } from './contracts.js';
import { TOOLS_SCHEMA_SQL } from './tools-contract.js';
import { hashSessionToken } from '../auth/session.js';
import { createStoredAuthModule } from '../routes/stored-auth.js';
import { MEDIA_TOOL_IDS } from '../analytics/registry.js';

const token = (id: string) => `synthetic-tools-${id}`;
const principal = (id = 'owner') => ({ kind: 'user' as const, userId: id, authSessionHash: hashSessionToken(token(id)) });
async function prepared() {
  const f = fixture();
  f.mutate(TOOLS_SCHEMA_SQL);
  for (const id of ['owner', 'other']) f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${principal(id).authSessionHash}','${id}',${Date.now() + 600000})`);
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'tools', generation: 1, initialize: true });
  const read = (id = 'owner') => port.readToolsSettings({ principal: principal(id) });
  const command = (input: unknown, id = 'owner', operationId = randomUUID()): StorageCommandEnvelope => ({
    protocolVersion: 1, storeId: 'tools', workerGeneration: 1, requestId: randomUUID(), operationId,
    principal: principal(id), command: { name: 'account.changeTools', input } as any,
  });
  return { f, port, read, command, close: async () => { await port.close(); f.cleanup(); } };
}

test('devices merge own-account usage and pins atomically, and uncertain retries never double count', async () => {
  const p = await prepared();
  try {
    const first = p.command({ action: 'use', toolId: 'weather' });
    await p.port.execute(first);
    await p.port.execute(first);
    await Promise.all(Array.from({ length: 8 }, () => p.port.execute(p.command({ action: 'use', toolId: 'weather' }))));
    await Promise.all(['calendar', 'weather'].map((toolId) => p.port.execute(p.command({ action: 'pin', toolId, pinned: true }))));
    assert.equal((await p.read()).usage.weather?.count, 9);
    assert.deepEqual(new Set((await p.read()).pinned), new Set(['news', 'calendar', 'weather']));
    assert.deepEqual(await p.read('other'), { pinned: ['news'], usage: {} });
    // Another tab reusing the same operation identity gets the committed outcome, not another increment.
    assert.equal((await p.port.execute({ ...first, requestId: randomUUID() })).state, 'committed');
    assert.equal((await p.read()).usage.weather?.count, 9);
    await assert.rejects(p.port.readToolsSettings({ principal: principal(), userId: 'other' } as any), { code: 'INVALID_ARGUMENT' });
    for (const input of [{ action: 'use', toolId: 'unknown' }, { action: 'use', toolId: 'news', userId: 'other' }, { action: 'pin', toolId: 'news', pinned: 'yes' }]) {
      await assert.rejects(p.port.execute(p.command(input)), { code: 'INVALID_ARGUMENT' });
    }
  } finally { await p.close(); }
});

test('tools HTTP checks login, Origin and strict input; persisted actions survive worker reopen', async () => {
  const p = await prepared();
  try {
    const app = new Hono().route('/api/auth', createStoredAuthModule({ port: p.port, storeId: 'tools', generation: 1, workspacePath: 'D:/synthetic-tools', recheckUserAccess: () => {} }).router);
    const headers = { cookie: `relay_session=${token('owner')}`, 'content-type': 'application/json' };
    const send = (input: unknown, extra = {}) => app.request('/api/auth/tools-settings', { method: 'PATCH', headers: { ...headers, ...extra }, body: JSON.stringify(input) });
    assert.equal((await app.request('/api/auth/tools-settings')).status, 401);
    const input = { action: 'pin', toolId: 'greeting', pinned: true };
    assert.equal((await send(input, { origin: 'https://hostile.invalid' })).status, 403);
    assert.equal((await send({ ...input, userId: 'other' })).status, 400);
    assert.equal((await send(input)).status, 200);
    const result = await app.request('/api/auth/tools-settings', { headers });
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual((await result.json() as any).pinned, ['news', 'greeting']);
    await p.port.close();
    const reopened = await StorageWorkerClient.open({ filename: p.f.filename, storeId: 'tools', generation: 2 });
    try { assert.deepEqual((await reopened.readToolsSettings({ principal: principal() })).pinned, ['news', 'greeting']); } finally { await reopened.close(); }
  } finally { await p.close(); }
});

test('disabled and forced-password accounts cannot access saved tools', async () => {
  const p = await prepared();
  try {
    for (const sql of ["UPDATE users SET disabled_at=1 WHERE id='owner'", "UPDATE users SET disabled_at=NULL,must_change_password=1 WHERE id='owner'"]) {
      p.f.mutate(sql);
      await assert.rejects(p.read(), { code: 'FORBIDDEN' });
      assert.equal((await p.port.execute(p.command({ action: 'use', toolId: 'news' }))).state, 'rejected');
    }
  } finally { await p.close(); }
});

test('a failed receipt rolls back usage; retrying the same action commits once', async () => {
  const p = await prepared();
  try {
    const request = p.command({ action: 'use', toolId: 'news' });
    p.f.mutate("CREATE TRIGGER tools_receipt_failure BEFORE INSERT ON _relay_storage_operations BEGIN SELECT RAISE(ABORT,'synthetic receipt failure');END");
    assert.equal((await p.port.execute(request)).state, 'unknown');
    assert.deepEqual((await p.read()).usage, {});
    p.f.mutate('DROP TRIGGER tools_receipt_failure');
    assert.equal((await p.port.execute(request)).state, 'committed');
    assert.equal((await p.read()).usage.news?.count, 1);
  } finally { await p.close(); }
});

test('new tools extend existing account settings without dropping earlier pins or counts', async () => {
  const p = await prepared();
  try {
    await p.port.execute(p.command({ action: 'use', toolId: 'weather' }));
    for (const toolId of ['calendar', 'weather', 'greeting', 'timestamp', 'json', 'qr', 'diff', 'pomodoro', 'units', 'dates', 'shopping', 'random', ...MEDIA_TOOL_IDS]) {
      assert.equal((await p.port.execute(p.command({ action: 'pin', toolId, pinned: true }))).state, 'committed');
    }
    for (const toolId of ['timestamp', 'json', 'qr', 'diff', 'pomodoro', 'units', 'dates', 'shopping', 'random', ...MEDIA_TOOL_IDS]) {
      assert.equal((await p.port.execute(p.command({ action: 'use', toolId }))).state, 'committed');
    }
    const state = await p.read();
    assert.equal(state.pinned.length, 13 + MEDIA_TOOL_IDS.length);
    assert.equal(state.usage.weather?.count, 1);
    assert.equal(state.usage.qr?.count, 1);
    assert.equal(state.usage.shopping?.count, 1);
    assert.equal(state.usage['video-edit']?.count, 1);
    assert.deepEqual(await p.read('other'), { pinned: ['news'], usage: {} });
  } finally { await p.close(); }
});
