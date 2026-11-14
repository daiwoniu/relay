import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getActiveSubscriptionSessionId,
  getSessionInputState,
  getSessionStreamingContent,
  isSessionRunning,
} from './session-streaming.ts';

const runningA = {
  isWaiting: false,
  isStreaming: true,
  isStopping: false,
  streamingSessionId: 'session-a',
  currentContent: 'A 的流式回复',
};

test('输入框和流式正文只跟随当前会话', () => {
  assert.equal(isSessionRunning(runningA, 'session-a'), true);
  assert.equal(isSessionRunning(runningA, 'session-b'), false);
  assert.equal(getSessionStreamingContent(runningA, 'session-a'), 'A 的流式回复');
  assert.equal(getSessionStreamingContent(runningA, 'session-b'), '');
});

test('WebSocket 订阅始终跟随当前打开的会话', () => {
  assert.equal(getActiveSubscriptionSessionId('session-b'), 'session-b');
  assert.equal(getActiveSubscriptionSessionId(null), null);
});

test('等待首个增量也属于当前会话运行状态', () => {
  const waitingB = {
    isWaiting: true,
    isStreaming: false,
    isStopping: false,
    streamingSessionId: 'session-b',
    currentContent: '',
  };
  assert.equal(isSessionRunning(waitingB, 'session-b'), true);
  assert.equal(isSessionRunning(waitingB, 'session-a'), false);
});

test('正在停止时仍锁定当前会话输入', () => {
  const stopping = {
    isWaiting: false,
    isStreaming: false,
    isStopping: true,
    streamingSessionId: 'session-a',
    currentContent: '部分回复',
  };
  assert.equal(isSessionRunning(stopping, 'session-a'), true);
  assert.equal(isSessionRunning(stopping, 'session-b'), false);
});

test('输入按钮使用当前会话状态，后台运行会话不会锁定其他会话', () => {
  assert.deepEqual(getSessionInputState('idle', runningA, 'session-b'), {
    isRunning: false,
    isStopping: false,
    isQueued: false,
  });
  assert.deepEqual(getSessionInputState('processing', runningA, 'session-b'), {
    isRunning: true,
    isStopping: false,
    isQueued: false,
  });
  assert.deepEqual(getSessionInputState('recovering', runningA, 'session-b'), {
    isRunning: true,
    isStopping: false,
    isQueued: false,
  });
  assert.deepEqual(getSessionInputState('awaiting_action', runningA, 'session-b'), {
    isRunning: true,
    isStopping: false,
    isQueued: false,
  });
  assert.deepEqual(getSessionInputState('stopping', runningA, 'session-b'), {
    isRunning: true,
    isStopping: true,
    isQueued: false,
  });
  assert.deepEqual(getSessionInputState('queued', runningA, 'session-b'), {
    isRunning: false,
    isStopping: false,
    isQueued: true,
  });
});
