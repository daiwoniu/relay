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

test('Codex token usage 按会话独立保存', () => {
  useChatStore.setState({ tokenUsageBySession: {} });
  const first = {
    inputTokens: 1200,
    cachedInputTokens: 800,
    outputTokens: 160,
    reasoningOutputTokens: 40,
    totalTokens: 1360,
    modelContextWindow: 200000,
  };
  const second = { ...first, inputTokens: 2400, outputTokens: 300, totalTokens: 2700 };

  useChatStore.getState().setTokenUsage('session-a', first);
  useChatStore.getState().setTokenUsage('session-b', second);

  assert.deepEqual(useChatStore.getState().tokenUsageBySession, {
    'session-a': first,
    'session-b': second,
  });
});

test('本轮用量只属于当前运行消息并在新一轮开始时清空', () => {
  const usage = {
    inputTokens: 126148,
    cachedInputTokens: 125440,
    outputTokens: 10,
    reasoningOutputTokens: 0,
    totalTokens: 126158,
    modelContextWindow: 353400,
  };

  useChatStore.getState().startWaiting();
  useChatStore.getState().setStreamingSessionId('session-a');
  useChatStore.getState().setStreamingTokenUsage(usage);
  assert.deepEqual(useChatStore.getState().streaming.tokenUsage, usage);

  useChatStore.getState().startWaiting();
  assert.equal(useChatStore.getState().streaming.tokenUsage, null);
});
