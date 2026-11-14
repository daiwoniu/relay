import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSearchHistoryUntilCurrentTarget } from './session-search-history-loader.ts';

test('导航目标在请求期间变化时保留已返回历史并继续加载最新目标', async () => {
  let target = { sessionId: 'session-1', messageId: 'message-70' };
  let loaded = Array.from({ length: 30 }, (_, index) => ({ id: `message-${index + 71}` }));
  const requests = [];

  const result = await loadSearchHistoryUntilCurrentTarget({
    getTarget: () => target,
    getLoadedMessages: () => loaded,
    loadOlderMessages: async (_sessionId, limit) => {
      requests.push({ limit });
      if (requests.length === 1) {
        target = { sessionId: 'session-1', messageId: 'message-20' };
        return { messages: Array.from({ length: 40 }, (_, index) => ({ id: `message-${index + 31}` })), hasMore: true };
      }
      return { messages: Array.from({ length: 30 }, (_, index) => ({ id: `message-${index + 1}` })), hasMore: false };
    },
    prependMessages: (_sessionId, messages) => { loaded = [...messages, ...loaded]; },
  });

  assert.equal(result.status, 'loaded');
  assert.equal(result.target.messageId, 'message-20');
  assert.deepEqual(requests, [{ limit: 100 }, { limit: 100 }]);
  assert.equal(loaded.some((message) => message.id === 'message-20'), true);
});

test('目标会话切换后停止合并旧会话返回的历史', async () => {
  let target = { sessionId: 'session-1', messageId: 'message-1' };
  let prependCount = 0;
  const result = await loadSearchHistoryUntilCurrentTarget({
    getTarget: () => target,
    getLoadedMessages: () => [{ id: 'message-30' }],
    loadOlderMessages: async () => {
      target = { sessionId: 'session-2', messageId: 'message-2' };
      return { messages: [{ id: 'message-1' }], hasMore: false };
    },
    prependMessages: () => { prependCount += 1; },
  });

  assert.equal(result.status, 'idle');
  assert.equal(prependCount, 0);
});
