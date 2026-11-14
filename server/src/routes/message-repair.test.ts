import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageRepairRouter } from './message-repair.js';

test('消息恢复接口要求管理员、可信来源和严格请求，拒绝外部路径', async () => {
  let calls = 0;
  let role: 'admin' | 'member' | null = null;
  const planId = '11111111-1111-4111-8111-111111111111';
  const app = createMessageRepairRouter({ actor: () => role ? { userId: 'owner', role } : undefined,
    originAllowed: (origin) => origin === 'http://localhost', service: {
      preview: async (owner, cursor) => { assert.equal(owner, 'owner'); assert.ok(cursor === undefined || cursor === 'next'); calls++; return { planId, expiresAt: 100, turnCount: 1, sessions: [], nextCursor: null, issues: [] }; },
      apply: (owner, id) => { assert.equal(owner, 'owner'); assert.equal(id, planId); calls++; return { restoredCount: 1 }; },
    } });
  const request = (action: string, body: unknown, origin = 'http://localhost') => app.request(`/message-repair/${action}`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await request('preview', {})).status, 401);
  role = 'member'; assert.equal((await request('preview', {})).status, 403);
  role = 'admin'; assert.equal((await request('preview', {}, 'http://evil')).status, 403);
  assert.equal((await request('preview', {}, '')).status, 403);
  assert.equal((await request('preview', { path: 'C:/secret' })).status, 400);
  assert.equal((await request('preview', { cursor: 3 })).status, 400);
  assert.equal((await request('preview', { cursor: 'a'.repeat(201) })).status, 400);
  assert.equal((await request('apply', { planId, dbPath: 'C:/secret' })).status, 400);
  assert.equal((await request('apply', { planId: 'invalid' })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await request('preview', {})).status, 200);
  assert.deepEqual(await (await request('apply', { planId })).json(), { restoredCount: 1 });
  assert.equal(calls, 2);
  assert.equal((await request('preview', { cursor: 'next' })).status, 200);
});

test('恢复失败不向浏览器泄露本机路径或底层异常', async () => {
  const app = createMessageRepairRouter({ actor: () => ({ userId: 'owner', role: 'admin' }), originAllowed: () => true,
    service: { preview: async () => { throw new Error('C:/secret/private.jsonl'); }, apply: () => ({ restoredCount: 0 }) } });
  const response = await app.request('/message-repair/preview', { method: 'POST',
    headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes('private.jsonl'), false);
});
