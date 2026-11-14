import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getInitialVisibleMessageStart,
  getPrependedScrollTop,
  getPreviousVisibleMessageStart,
  MESSAGE_AUTO_SCROLL_THRESHOLD_PX,
  MESSAGE_BOTTOM_EDGE_EPSILON_PX,
  MESSAGE_RENDER_BATCH_SIZE,
  shouldKeepLatestMessageVisibleAfterResize,
  shouldPreserveLocatedMessageWindow,
  shouldResetOlderMessageAvailability,
} from './message-history-window.ts';

test('消息窗口默认只显示最新 30 条', () => {
  assert.equal(MESSAGE_RENDER_BATCH_SIZE, 30);
  assert.equal(getInitialVisibleMessageStart(0), 0);
  assert.equal(getInitialVisibleMessageStart(30), 0);
  assert.equal(getInitialVisibleMessageStart(31), 1);
  assert.equal(getInitialVisibleMessageStart(95), 65);
});

test('退出消息搜索时保留已定位的消息窗口', () => {
  assert.equal(shouldPreserveLocatedMessageWindow('message-1', null), true);
  assert.equal(shouldPreserveLocatedMessageWindow('message-1', 'message-2'), false);
  assert.equal(shouldPreserveLocatedMessageWindow(null, null), false);
});

test('滚动到顶部时每次向前加载 30 条', () => {
  assert.equal(getPreviousVisibleMessageStart(65), 35);
  assert.equal(getPreviousVisibleMessageStart(35), 5);
  assert.equal(getPreviousVisibleMessageStart(5), 0);
  assert.equal(getPreviousVisibleMessageStart(0), 0);
});

test('历史消息插入后保持原内容的视觉位置', () => {
  assert.equal(getPrependedScrollTop(24, 1200, 2100), 924);
  assert.equal(getPrependedScrollTop(0, 1200, 1200), 0);
  assert.equal(getPrependedScrollTop(10, 1200, 1100), 10);
});

test('同步快照缩短消息数组时恢复历史分页能力', () => {
  assert.equal(shouldResetOlderMessageAvailability(90, 30, true), true);
  assert.equal(shouldResetOlderMessageAvailability(30, 60, true), false);
  assert.equal(shouldResetOlderMessageAvailability(90, 30, false), false);
});

test('软键盘缩小消息区时保持原本位于底部的内容可见', () => {
  assert.equal(shouldKeepLatestMessageVisibleAfterResize(1200, 1800, 600, 320), true);
  assert.equal(shouldKeepLatestMessageVisibleAfterResize(1160, 1800, 600, 320), false);
  assert.equal(MESSAGE_AUTO_SCROLL_THRESHOLD_PX, 64);
  assert.equal(MESSAGE_BOTTOM_EDGE_EPSILON_PX, 1);
});

test('软键盘关闭后识别浏览器已钳制到底部的滚动位置', () => {
  assert.equal(shouldKeepLatestMessageVisibleAfterResize(900, 1500, 320, 600), true);
});

test('阅读历史消息时容器高度变化不强制滚到底部', () => {
  assert.equal(shouldKeepLatestMessageVisibleAfterResize(500, 1800, 600, 320), false);
  assert.equal(shouldKeepLatestMessageVisibleAfterResize(1200, 1800, 600, 600), false);
});
