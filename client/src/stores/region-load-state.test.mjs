import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginRegionLoad,
  commitRegionError,
  commitRegionReady,
  createMessageRegionLoadState,
  createRegionLoadState,
  isCurrentRegionGeneration,
} from './region-load-state.ts';

test('区域状态各自推进且不会互相污染', () => {
  const navigation = beginRegionLoad(createRegionLoadState());
  const messages = beginRegionLoad(createMessageRegionLoadState());
  const failedNavigation = commitRegionError(navigation, navigation.generation, '导航失败');

  assert.equal(failedNavigation.status, 'error');
  assert.equal(messages.status, 'loading');
  assert.equal(messages.error, null);
});

test('只有当前 generation 可以提交结果', () => {
  const first = beginRegionLoad(createRegionLoadState());
  const second = beginRegionLoad(first);

  assert.equal(commitRegionReady(second, first.generation), second);
  assert.equal(commitRegionError(second, first.generation, '旧错误'), second);
  assert.equal(commitRegionReady(second, second.generation).status, 'ready');
  assert.equal(isCurrentRegionGeneration(second, first.generation), false);
  assert.equal(isCurrentRegionGeneration(second, second.generation), true);
});

test('消息区域初始状态包含 revision、缓存来源和稳定游标', () => {
  assert.deepEqual(createMessageRegionLoadState(), {
    status: 'idle',
    generation: 0,
    error: null,
    revision: null,
    cacheSource: 'none',
    hasMore: false,
    nextCursor: null,
    dirty: false,
  });
});
