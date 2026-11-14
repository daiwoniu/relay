import assert from 'node:assert/strict';
import test from 'node:test';
import type { ShareService } from '../services/shares.js';
import { ServiceError } from '../services/errors.js';
import { createSharesRouter } from './shares.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';

function createRouter() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const service = {
    previewForActor: (...args: unknown[]) => { calls.push({ name: 'preview', args }); return { title: '分享', messageCount: 1, createdAt: 1, expiresAt: 2, snapshot: { version: 1, messages: [] } }; },
    createForActor: (...args: unknown[]) => { calls.push({ name: 'create', args }); return { id: 'share-1', publicToken: 'a'.repeat(64), createdAt: 1, expiresAt: 2 }; },
    listForActor: (...args: unknown[]) => { calls.push({ name: 'list', args }); return { items: [], total: 0 }; },
    revokeForActor: (...args: unknown[]) => { calls.push({ name: 'revoke', args }); },
    deleteForActor: (...args: unknown[]) => { calls.push({ name: 'delete', args }); },
    readPublic: () => ({ state: 'not_found' as const }),
  } as unknown as ShareService;
  return {
    calls,
    router: createSharesRouter({
      service,
      authenticate: (cookie) => cookie === 'valid' ? { id: 'owner-1', username: 'owner', displayName: 'owner', role: 'admin', avatarUpdatedAt: null, defaultProjectId: null, defaultEngine: 'codex', defaultModelId: null, mustChangePassword: false, disabledAt: null } : null,
    }),
  };
}

test('登录用户可以创建、列出、取消和删除自己的分享', async () => {
  const { router, calls } = createRouter();
  const requestBody = { sessionId, scope: 'single', messageIds: [messageId], title: '分享', includeProcess: false, expiry: { type: 'preset', value: '1d' } };
  const previewResponse = await router.request('http://localhost/preview', {
    method: 'POST', headers: { cookie: 'valid', 'content-type': 'application/json' }, body: JSON.stringify(requestBody),
  });
  assert.equal(previewResponse.status, 200);
  const createResponse = await router.request('http://localhost/', {
    method: 'POST', headers: { cookie: 'valid', 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  assert.equal(createResponse.status, 201);
  assert.equal((await router.request('http://localhost/?limit=10&offset=2', { headers: { cookie: 'valid' } })).status, 200);
  assert.equal((await router.request('http://localhost/share-1/revoke', { method: 'POST', headers: { cookie: 'valid' } })).status, 200);
  assert.equal((await router.request('http://localhost/share-1', { method: 'DELETE', headers: { cookie: 'valid' } })).status, 200);
  assert.deepEqual(calls.map((call) => [call.name, call.args[0]]), [
    ['preview', { userId: 'owner-1', role: 'admin' }], ['create', { userId: 'owner-1', role: 'admin' }],
    ['list', { userId: 'owner-1', role: 'admin' }], ['revoke', { userId: 'owner-1', role: 'admin' }],
    ['delete', { userId: 'owner-1', role: 'admin' }],
  ]);
});

test('分享管理路由拒绝未登录、畸形 JSON 和领域冲突', async () => {
  const { router } = createRouter();
  assert.equal((await router.request('http://localhost/')).status, 401);
  assert.equal((await router.request('http://localhost/preview', { method: 'POST' })).status, 401);
  assert.equal((await router.request('http://localhost/', { method: 'POST', headers: { cookie: 'valid', 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await router.request('http://localhost/preview', { method: 'POST', headers: { cookie: 'valid', 'content-type': 'application/json' }, body: '{' })).status, 400);
  const conflict = createSharesRouter({
    service: { revokeForActor: () => { throw new ServiceError(409, '分享已经取消'); } } as unknown as ShareService,
    authenticate: () => ({ id: 'owner-1', username: 'owner', displayName: 'owner', role: 'admin', avatarUpdatedAt: null, defaultProjectId: null, defaultEngine: 'codex', defaultModelId: null, mustChangePassword: false, disabledAt: null }),
  });
  assert.equal((await conflict.request('http://localhost/share-1/revoke', { method: 'POST' })).status, 409);
});
