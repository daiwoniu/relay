import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getDefaultSearchMatchIndex,
  getNextSearchHistoryRequest,
  getSearchNavigationPosition,
  getSearchMessageWindowRange,
  moveSearchMatchIndex,
} from './session-search-navigation.ts';

test('默认选择单个会话中的最近一条匹配消息', () => {
  assert.equal(getDefaultSearchMatchIndex(0), -1);
  assert.equal(getDefaultSearchMatchIndex(1), 0);
  assert.equal(getDefaultSearchMatchIndex(4), 3);
});

test('匹配引用截断时按真实总数显示最近结果的位置', () => {
  assert.equal(getSearchNavigationPosition(0, 500, 620), 121);
  assert.equal(getSearchNavigationPosition(499, 500, 620), 620);
  assert.equal(getSearchNavigationPosition(-1, 0, 620), 0);
});

test('上一条和下一条导航停在边界且不循环', () => {
  assert.equal(moveSearchMatchIndex(3, 4, 'previous'), 2);
  assert.equal(moveSearchMatchIndex(0, 4, 'previous'), 0);
  assert.equal(moveSearchMatchIndex(2, 4, 'next'), 3);
  assert.equal(moveSearchMatchIndex(3, 4, 'next'), 3);
  assert.equal(moveSearchMatchIndex(-1, 0, 'next'), -1);
});

test('目标消息未加载时从当前缓存尾部继续请求更早消息', () => {
  const loadedIds = new Set(['message-100', 'message-101']);

  assert.deepEqual(
    getNextSearchHistoryRequest(loadedIds, 'message-1', 2, true),
    { limit: 100, offset: 2 },
  );
  assert.equal(getNextSearchHistoryRequest(loadedIds, 'message-100', 2, true), null);
  assert.equal(getNextSearchHistoryRequest(loadedIds, 'message-1', 2, false), null);
  assert.equal(getNextSearchHistoryRequest(loadedIds, null, 2, true), null);
});

test('搜索模式保留目标前上下文并连续渲染到最新消息', () => {
  assert.deepEqual(getSearchMessageWindowRange(50, 100), { start: 44, end: 100 });
  assert.deepEqual(getSearchMessageWindowRange(1, 100), { start: 0, end: 100 });
  assert.deepEqual(getSearchMessageWindowRange(98, 100), { start: 92, end: 100 });
  assert.deepEqual(getSearchMessageWindowRange(-1, 100), { start: 70, end: 100 });
});
