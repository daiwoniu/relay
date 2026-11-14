import assert from 'node:assert/strict';
import test from 'node:test';
import { loadMessageRegion } from './message-region-controller.ts';
import { getMessageRevisionDisposition } from '../../stores/message-snapshot.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function page(revision, ids = ['message-1']) {
  return {
    sessionId: 'session-1', revision, hasMore: true,
    nextCursor: { beforeCreatedAt: 1, beforeId: ids[0] },
    messages: ids.map((id, index) => ({
      id, session_id: 'session-1', turn_id: `turn-${id}`, role: 'assistant', content: id,
      phase: 'final_answer', created_at: index + 1, duration: null, stopped: false,
      hasDetails: false, processItemCount: 0, processNarrativeCount: 0, changedFileCount: 0,
    })),
  };
}

function createHarness(cachePromise, networkPromise) {
  const events = [];
  let current = true;
  const run = loadMessageRegion({
    readCache: () => cachePromise,
    requestNetwork: () => networkPromise,
    isCurrent: () => current,
    applyCache: (value) => events.push(['cache', value.revision]),
    applyNetwork: (value) => events.push(['network', value.revision]),
    applyUnchanged: (revision) => events.push(['unchanged', revision]),
    applyError: (_error, cached) => events.push(['error', cached]),
    writeCache: (value) => events.push(['write', value.revision]),
  });
  return { events, run, invalidate: () => { current = false; } };
}

test('缓存先到立即展示，网络随后覆盖并写回', async () => {
  const cache = deferred();
  const network = deferred();
  const harness = createHarness(cache.promise, network.promise);
  cache.resolve(page(2));
  await Promise.resolve();
  network.resolve({ unchanged: false, page: page(3) });
  assert.equal(await harness.run, 'network');
  assert.deepEqual(harness.events, [['cache', 2], ['network', 3], ['write', 3]]);
});

test('网络先到后到的缓存不得覆盖网络', async () => {
  const cache = deferred();
  const network = deferred();
  const harness = createHarness(cache.promise, network.promise);
  network.resolve({ unchanged: false, page: page(3) });
  assert.equal(await harness.run, 'network');
  cache.resolve(page(2));
  await Promise.resolve();
  assert.deepEqual(harness.events, [['network', 3], ['write', 3]]);
});

test('A→B→A 旧 generation 失效后不提交', async () => {
  const network = deferred();
  const harness = createHarness(Promise.resolve(page(1)), network.promise);
  harness.invalidate();
  network.resolve({ unchanged: false, page: page(2) });
  assert.equal(await harness.run, 'stale');
  assert.deepEqual(harness.events, []);
});

test('unchanged 保留已有内容并进入 ready', async () => {
  const harness = createHarness(Promise.resolve(null), Promise.resolve({ unchanged: true, revision: 4 }));
  assert.equal(await harness.run, 'unchanged');
  assert.deepEqual(harness.events, [['unchanged', 4]]);
});

test('无缓存网络失败只提交消息区域错误', async () => {
  const harness = createHarness(Promise.resolve(null), Promise.reject(new Error('网络失败')));
  assert.equal(await harness.run, 'error');
  assert.deepEqual(harness.events, [['error', false]]);
});

test('已有缓存网络失败保留缓存并标记校准错误', async () => {
  const cache = deferred();
  const network = deferred();
  const harness = createHarness(cache.promise, network.promise);
  cache.resolve(page(2));
  await Promise.resolve();
  network.reject(new Error('网络失败'));
  assert.equal(await harness.run, 'error');
  assert.deepEqual(harness.events, [['cache', 2], ['error', true]]);
});

test('revision 连续事件直接合并，跳号或倒退需要不同处理', () => {
  assert.equal(getMessageRevisionDisposition(4, 5), 'continuous');
  assert.equal(getMessageRevisionDisposition(5, 5), 'duplicate');
  assert.equal(getMessageRevisionDisposition(5, 7), 'gap');
  assert.equal(getMessageRevisionDisposition(5, 4), 'stale');
  assert.equal(getMessageRevisionDisposition(null, 8), 'initial');
});

test('历史页携带稳定游标而不是通过消息长度推断', () => {
  const result = page(8, ['message-3', 'message-4']);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.nextCursor, { beforeCreatedAt: 1, beforeId: 'message-3' });
});
