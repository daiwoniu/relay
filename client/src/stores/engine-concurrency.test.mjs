import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngineConcurrencyStore } from './engine-concurrency.ts';

const concurrency = (resourceKey, maxActiveTurns = 2) => ({ resourceKey, engineId: 'codex', label: 'Codex', maxActiveTurns, activeTurns: 1, queuedTurns: 1, cooldownUntil: null, probeInProgress: false, windows: [] });
const queue = (queueId, createdAt, overrides = {}) => ({ queueId, sessionId: 's1', engineId: 'codex', resourceKey: 'codex:default', label: 'Codex', state: 'queued', position: 2, activeTurns: 2, maxActiveTurns: 2, cooldownUntil: null, createdAt, ...overrides });

test('REST 快照替换并发资源集合，实时事件仅更新对应资源', () => {
  const store = createEngineConcurrencyStore();
  store.getState().replaceConcurrencySnapshot([concurrency('codex:default'), concurrency('codebuddy:default', 4)]);
  store.getState().upsertConcurrency(concurrency('codex:default', 3));
  assert.equal(store.getState().concurrencyByResourceKey['codex:default'].maxActiveTurns, 3);
  assert.equal(store.getState().concurrencyByResourceKey['codebuddy:default'].maxActiveTurns, 4);
  store.getState().replaceConcurrencySnapshot([concurrency('codex:default', 5)]);
  assert.deepEqual(Object.keys(store.getState().concurrencyByResourceKey), ['codex:default']);
});

test('旧 queue ID 不覆盖新一轮排队，开始事件只清理匹配队列', () => {
  const store = createEngineConcurrencyStore();
  store.getState().applyQueueSnapshot('s1', queue('new', 20));
  store.getState().applyQueueSnapshot('s1', queue('old', 10));
  assert.equal(store.getState().queueBySessionId.s1.queueId, 'new');
  store.getState().clearQueue('s1', 'old');
  assert.equal(store.getState().queueBySessionId.s1.queueId, 'new');
  store.getState().clearQueue('s1', 'new');
  assert.equal(store.getState().queueBySessionId.s1, undefined);
});

test('sync_state 权威快照可以替换或清空当前会话队列', () => {
  const store = createEngineConcurrencyStore();
  store.getState().applyQueueSnapshot('s1', queue('old', 20));
  store.getState().applyQueueSnapshot('s1', queue('server', 10), true);
  assert.equal(store.getState().queueBySessionId.s1.queueId, 'server');
  store.getState().applyQueueSnapshot('s1', null, true);
  assert.equal(store.getState().queueBySessionId.s1, undefined);
});

test('实时取消事件清空当前排队快照', () => {
  const store = createEngineConcurrencyStore();
  store.getState().applyQueueSnapshot('s1', queue('q1', 20));
  store.getState().applyQueueSnapshot('s1', null);
  assert.equal(store.getState().queueBySessionId.s1, undefined);
});

test('只锁正在保存的资源卡片', () => {
  const store = createEngineConcurrencyStore();
  store.getState().setSaving('codex:default', true);
  assert.deepEqual(store.getState().savingResourceKeys, ['codex:default']);
  store.getState().setSaving('codebuddy:default', true);
  store.getState().setSaving('codex:default', false);
  assert.deepEqual(store.getState().savingResourceKeys, ['codebuddy:default']);
});
