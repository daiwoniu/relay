import assert from 'node:assert/strict';
import test from 'node:test';

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => {},
  },
});

const { useChatStore } = await import('./chat.ts');

test('进入正在停止时保留流式内容并持续锁定会话', () => {
  const store = useChatStore.getState();
  store.finishStreaming();
  store.startWaiting(100, 'submitted');
  store.setStreamingSessionId('session-a');
  store.startStreaming();
  store.appendDelta('已经生成的部分内容', 'final_answer');
  store.startStopping();

  const stopping = useChatStore.getState().streaming;
  assert.equal(stopping.isStopping, true);
  assert.equal(stopping.isStreaming, true);
  assert.equal(stopping.isWaiting, false);
  assert.equal(stopping.currentContent, '');
  assert.equal(stopping.processContent, '已经生成的部分内容');
  assert.equal(stopping.streamingSessionId, 'session-a');

  useChatStore.getState().finishStreaming();
  assert.equal(useChatStore.getState().streaming.isStopping, false);
});
