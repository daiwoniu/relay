import assert from 'node:assert/strict';
import test from 'node:test';
import { createEnginePreferencesRouter, createSessionForkRouter, createSessionListRouter } from './sessions.js';
import type { Actor } from '../auth/authorization.js';
import type { RelayEnv } from '../auth/authorization.js';
import { Hono } from 'hono';
import { ServiceError } from '../services/errors.js';

const session = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', title: '会话', created_at: 1, updated_at: 1,
  pinned: 0 as const, pinned_at: null, project_id: null, engine: 'codex' as const,
  codex_archived: false, can_fork: false, status: 'idle' as const,
  engine_preferences: { modelId: null, reasoningEffort: null, revision: 0 },
  ...overrides,
});

const catalog = {
  engineId: 'codex' as const, fetchedAt: 1, stale: false,
  models: [{
    id: 'gpt-test', displayName: 'GPT Test', isDefault: true, inputModalities: ['text' as const],
    serviceTiers: [{ id: 'priority', label: 'Fast' }],
    reasoning: { supported: true, scope: 'model' as const, defaultOptionId: 'medium', options: [
      { id: 'medium', label: '中' }, { id: 'high', label: '高' },
    ] },
  }],
};

test('会话速度选择通过偏好接口保存，未声明档位拒绝', async () => {
  let current = session();
  let savedTier: string | null | undefined;
  const router = createEnginePreferencesRouter({
    getSession: () => current,
    getCatalog: async () => catalog,
    updatePreferences: (_actor, _id, input) => {
      savedTier = input.serviceTier;
      current = session({ engine_preferences: { modelId: input.modelId, reasoningEffort: input.reasoningEffort, serviceTier: input.serviceTier, revision: 1 } });
      return current;
    },
    broadcast: () => undefined,
  });
  const patch = (serviceTier: string) => router.request(`/${current.id}/engine-preferences`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: 'gpt-test', reasoningEffort: null, serviceTier, expectedRevision: 0 }),
  });
  assert.equal((await patch('unknown')).status, 422);
  assert.equal(savedTier, undefined);
  const response = await patch('priority');
  assert.equal(response.status, 200);
  assert.equal(savedTier, 'priority');
  assert.equal((await response.json() as any).session.engine_preferences.serviceTier, 'priority');
});

test('旧客户端省略速度字段时保留同模型偏好，切换模型时恢复继承', async () => {
  let current = session({ engine_preferences: { modelId: 'gpt-test', reasoningEffort: null, serviceTier: 'priority', revision: 0 } });
  const received: Array<string | null | undefined> = [];
  const router = createEnginePreferencesRouter({
    getSession: () => current,
    getCatalog: async () => ({ ...catalog, models: [...catalog.models, {
      ...catalog.models[0], id: 'other-model', isDefault: false, serviceTiers: [],
    }] }),
    updatePreferences: (_actor, _id, input) => {
      received.push(input.serviceTier);
      current = session({ engine_preferences: {
        modelId: input.modelId, reasoningEffort: input.reasoningEffort,
        serviceTier: input.serviceTier, revision: input.expectedRevision + 1,
      } });
      return current;
    },
    broadcast: () => undefined,
  });
  const patch = (modelId: string, expectedRevision: number) => router.request(`/${current.id}/engine-preferences`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId, reasoningEffort: null, expectedRevision }),
  });
  assert.equal((await patch('gpt-test', 0)).status, 200);
  assert.equal((await patch('other-model', 1)).status, 200);
  assert.deepEqual(received, ['priority', null]);
});

test('空闲会话更新模型偏好并广播专用事件', async () => {
  let current = session();
  const events: unknown[] = [];
  const router = createEnginePreferencesRouter({
    getSession: () => current,
    getCatalog: async () => catalog,
    updatePreferences: (_actor, _id, input) => current = session({
      engine_preferences: { modelId: input.modelId, reasoningEffort: input.reasoningEffort, revision: 1 },
    }),
    broadcast: (event) => events.push(event),
  });
  const response = await router.request(`/${current.id}/engine-preferences`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: 'gpt-test', reasoningEffort: 'high', expectedRevision: 0 }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).session.engine_preferences.revision, 1);
  assert.deepEqual(events, [{
    type: 'engine_preferences_updated', sessionId: current.id,
    preferences: { modelId: 'gpt-test', reasoningEffort: 'high', revision: 1 },
  }]);
});

test('偏好接口拒绝运行态、未绑定草稿、非法模型组合与宽松 body', async () => {
  let current = session();
  const router = createEnginePreferencesRouter({
    getSession: () => current,
    getCatalog: async () => catalog,
    updatePreferences: () => { throw new Error('不应更新'); },
    broadcast: () => undefined,
  });
  const patch = (body: unknown) => router.request(`/${current.id}/engine-preferences`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  current = session({ status: 'processing' });
  assert.equal((await patch({ modelId: 'gpt-test', reasoningEffort: 'high', expectedRevision: 0 })).status, 409);
  current = session({ engine: null });
  assert.equal((await patch({ modelId: 'gpt-test', reasoningEffort: 'high', expectedRevision: 0 })).status, 409);
  current = session();
  assert.equal((await patch({ modelId: 'missing', reasoningEffort: 'high', expectedRevision: 0 })).status, 422);
  assert.equal((await patch({ modelId: 'gpt-test', reasoningEffort: 'extreme', expectedRevision: 0 })).status, 422);
  assert.equal((await patch({ modelId: null, reasoningEffort: 'high', expectedRevision: 0 })).status, 422);
  assert.equal((await patch({ modelId: null, reasoningEffort: null, expectedRevision: 0, extra: true })).status, 400);
});

test('revision 冲突保留稳定错误码且广播失败不回滚成功更新', async () => {
  let current = session();
  const conflict = createEnginePreferencesRouter({
    getSession: () => current, getCatalog: async () => catalog,
    updatePreferences: () => { throw new ServiceError(409, '偏好冲突', 'SESSION_ENGINE_PREFERENCES_CONFLICT'); },
    broadcast: () => undefined,
  });
  const request = (router: ReturnType<typeof createEnginePreferencesRouter>) => router.request(`/${current.id}/engine-preferences`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: 'gpt-test', reasoningEffort: 'high', expectedRevision: 0 }),
  });
  const conflictResponse = await request(conflict);
  assert.equal(conflictResponse.status, 409);
  assert.equal((await conflictResponse.json() as any).code, 'SESSION_ENGINE_PREFERENCES_CONFLICT');

  const successful = createEnginePreferencesRouter({
    getSession: () => current, getCatalog: async () => catalog,
    updatePreferences: () => current = session({ engine_preferences: { modelId: 'gpt-test', reasoningEffort: 'high', revision: 1 } }),
    broadcast: () => { throw new Error('socket closed'); },
    diagnostic: () => undefined,
  });
  assert.equal((await request(successful)).status, 200);
  assert.equal(current.engine_preferences.revision, 1);
});

test('会话分支路由接受可选消息 ID、严格校验 body 并保留服务错误', async () => {
  const calls: unknown[] = [];
  const actor: Actor = { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'admin' };
  const router = createSessionForkRouter({
    forkForActor: async (receivedActor, sourceSessionId, input) => {
      calls.push({ actor: receivedActor, sourceSessionId, input });
      if (sourceSessionId === 'missing') throw new ServiceError(404, '来源会话不存在');
      return session({ id: '22222222-2222-4222-8222-222222222222', can_fork: true });
    },
  });
  const app = new Hono<RelayEnv>();
  app.use('*', async (c, next) => {
    c.set('relayActor', actor);
    return next();
  });
  app.route('/', router);
  const sourceId = '11111111-1111-4111-8111-111111111111';
  const messageId = '33333333-3333-4333-8333-333333333333';
  const response = await app.request(`/${sourceId}/fork`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId }),
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json() as any).session.id, '22222222-2222-4222-8222-222222222222');
  assert.deepEqual(calls, [{ actor, sourceSessionId: sourceId, input: { messageId } }]);

  const invalid = await app.request(`/${sourceId}/fork`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ extra: true }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await app.request('/missing/fork', { method: 'POST' })).status, 404);
});

test('会话列表不等待 Codex 归档后台刷新即可返回', async () => {
  const actor: Actor = { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'admin' };
  let backgroundOptions: {
    onSuccess?: (threadIds: Set<string>) => void;
    onError?: (error: Error) => void;
  } | undefined;
  const synced: string[][] = [];
  const router = createSessionListRouter({
    readCachedArchivedThreadIds: () => new Set(['thread-cached']),
    refreshArchivedThreadIdsInBackground: (options) => {
      backgroundOptions = options;
      return true;
    },
    syncCodexArchiveStatuses: (threadIds) => { synced.push([...threadIds]); },
    listForActor: (receivedActor) => {
      assert.deepEqual(receivedActor, actor);
      return [session()];
    },
    diagnostic: () => undefined,
  });
  const app = new Hono<RelayEnv>();
  app.use('*', async (c, next) => { c.set('relayActor', actor); return next(); });
  app.route('/', router);

  const response = await app.request('/');
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any[]).length, 1);
  assert.deepEqual(synced, [['thread-cached']]);
  assert.ok(backgroundOptions?.onSuccess);

  backgroundOptions.onSuccess(new Set(['thread-fresh']));
  assert.deepEqual(synced, [['thread-cached'], ['thread-fresh']]);
});
