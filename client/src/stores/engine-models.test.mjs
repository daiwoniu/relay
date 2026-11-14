import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngineModelsStore, mergeSessionByPreferencesRevision } from './engine-models.ts';

const catalog = (engineId = 'codex', stale = false) => ({ engineId, fetchedAt: 1, stale, models: [] });

test('目录按引擎隔离、重复请求去重并区分 ready/stale/error', async () => {
  let calls = 0;
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const store = createEngineModelsStore(async () => { calls += 1; return pending; });
  const first = store.getState().load('codex');
  const second = store.getState().load('codex');
  assert.equal(calls, 1);
  assert.equal(store.getState().byEngine.codex.status, 'loading');
  resolve(catalog());
  await Promise.all([first, second]);
  assert.equal(store.getState().byEngine.codex.status, 'ready');

  const staleStore = createEngineModelsStore(async () => catalog('codebuddy', true));
  await staleStore.getState().load('codebuddy');
  assert.equal(staleStore.getState().byEngine.codebuddy.status, 'stale');
  const errorStore = createEngineModelsStore(async () => { throw new Error('offline'); });
  await assert.rejects(() => errorStore.getState().load('codex'));
  assert.equal(errorStore.getState().byEngine.codex.status, 'error');
});

test('refresh 显式传给 API，切换草稿引擎清空不匹配选择', async () => {
  const refreshes = [];
  const store = createEngineModelsStore(async (_engine, refresh) => { refreshes.push(refresh); return catalog(); });
  store.getState().setDraft('session-1', 'codex', { modelId: 'gpt-test', reasoningEffort: 'high' });
  store.getState().switchDraftEngine('session-1', 'codebuddy');
  assert.equal(store.getState().draftBySession['session-1'], undefined);
  await store.getState().load('codex', { refresh: true });
  assert.deepEqual(refreshes, [true]);
});

test('新会话发送成功后可单独清理模型草稿', () => {
  const store = createEngineModelsStore(async () => catalog());
  store.getState().setDraft('new:project-1', 'codex', { modelId: 'gpt-test', reasoningEffort: 'high' });
  store.getState().setDraft('session-1', 'codex', { modelId: 'gpt-keep', reasoningEffort: null });
  store.getState().clearDraft('new:project-1');
  assert.equal(store.getState().draftBySession['new:project-1'], undefined);
  assert.equal(store.getState().draftBySession['session-1'].modelId, 'gpt-keep');
});

test('Session 合并拒绝旧偏好 revision 但保留其他权威字段更新', () => {
  const current = { id: 's1', title: '旧', engine_preferences: { modelId: 'new', reasoningEffort: 'high', revision: 3 } };
  const incoming = { id: 's1', title: '新', status: 'processing', engine_preferences: { modelId: 'old', reasoningEffort: null, revision: 2 } };
  assert.deepEqual(mergeSessionByPreferencesRevision(current, incoming), {
    ...incoming, engine_preferences: current.engine_preferences,
  });
});

test('失效后只重新加载指定引擎目录并保留模型偏好草稿', async () => {
  const calls = [];
  const store = createEngineModelsStore(async (engineId, refresh) => {
    calls.push([engineId, refresh]);
    return catalog(engineId);
  });
  store.getState().setDraft('session-1', 'codex', { modelId: 'gpt-test', reasoningEffort: 'high' });
  await store.getState().load('codex');
  await store.getState().load('codebuddy');

  store.getState().invalidate('codex');

  assert.equal(store.getState().byEngine.codex, undefined);
  assert.equal(store.getState().byEngine.codebuddy.status, 'ready');
  assert.equal(store.getState().draftBySession['session-1'].modelId, 'gpt-test');
  await store.getState().load('codex');
  assert.deepEqual(calls, [
    ['codex', false],
    ['codebuddy', false],
    ['codex', false],
  ]);
});
