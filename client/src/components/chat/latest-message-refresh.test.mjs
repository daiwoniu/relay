import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LATEST_MESSAGE_LOADING_DELAY_MS,
  MESSAGE_RESUME_RECONNECT_THRESHOLD_MS,
  getLatestMessageBubbleStatus,
  isLatestMessageReplyMissing,
  shouldRefreshOnPageShow,
  shouldReconnectAfterResume,
} from './latest-message-refresh.ts';

test('只有缓存尾部缺少助手回复时才显示最新消息加载提示', () => {
  assert.equal(LATEST_MESSAGE_LOADING_DELAY_MS, 250);
  assert.equal(isLatestMessageReplyMissing([]), true);
  assert.equal(isLatestMessageReplyMissing([{ role: 'user' }]), true);
  assert.equal(isLatestMessageReplyMissing([{ role: 'assistant' }]), false);
  assert.equal(isLatestMessageReplyMissing([{ role: 'user' }, { role: 'assistant' }]), false);
  assert.equal(getLatestMessageBubbleStatus('loading', false, false, true), 'idle');
  assert.equal(getLatestMessageBubbleStatus('loading', true, false, true), 'loading');
  assert.equal(getLatestMessageBubbleStatus('error', true, false, true), 'error');
  assert.equal(getLatestMessageBubbleStatus('loading', true, true, true), 'idle');
  assert.equal(getLatestMessageBubbleStatus('loading', true, false, false), 'idle');
  assert.equal(getLatestMessageBubbleStatus('error', true, false, false), 'idle');
});

test('长时间后台或 BFCache 恢复时主动替换可能半开的 WebSocket', () => {
  assert.equal(MESSAGE_RESUME_RECONNECT_THRESHOLD_MS, 30_000);
  assert.equal(shouldReconnectAfterResume(1_000, 31_000, false), true);
  assert.equal(shouldReconnectAfterResume(1_000, 30_999, false), false);
  assert.equal(shouldReconnectAfterResume(null, 31_000, true), true);
  assert.equal(shouldReconnectAfterResume(null, 31_000, false), false);
  assert.equal(shouldRefreshOnPageShow(false), false);
  assert.equal(shouldRefreshOnPageShow(true), true);
});
