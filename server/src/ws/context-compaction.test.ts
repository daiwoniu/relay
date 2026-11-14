import assert from 'node:assert/strict';
import test from 'node:test';
import { getContextCompactionIdentity, persistContextCompactionCountSafely, persistContextCompactionItemSafely } from './context-compaction.js';

test('新版 contextCompaction 完成项提取 thread 与 turn 幂等身份', () => {
  assert.deepEqual(getContextCompactionIdentity({
    type: 'item_complete',
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { id: 'compaction-1', type: 'contextCompaction', status: 'completed' },
  }), { threadId: 'thread-1', turnId: 'turn-1' });
  assert.equal(getContextCompactionIdentity({
    type: 'item_complete',
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { id: 'answer-1', type: 'agentMessage', status: 'completed' },
  }), null);
});

test('新版与旧版整理事件共用相同持久化入口身份', () => {
  const calls: Array<[string, string, string]> = [];
  persistContextCompactionItemSafely('session-1', {
    type: 'item_complete', threadId: 'thread-1', turnId: 'turn-1',
    item: { id: 'compaction-1', type: 'contextCompaction', status: 'completed' },
  }, (id, event) => calls.push([id, event.threadId, event.turnId]));
  assert.deepEqual(calls, [['session-1', 'thread-1', 'turn-1']]);
});

test('上下文自动整理通知按会话递增一次且持久化失败不阻断通知链路', () => {
  const calls: Array<[string, string, string]> = [];
  persistContextCompactionCountSafely('session-1', { threadId: 'thread-1', turnId: 'turn-1' }, (id, event) => {
    calls.push([id, event.threadId, event.turnId]);
  });
  assert.deepEqual(calls, [['session-1', 'thread-1', 'turn-1']]);

  const originalError = console.error;
  console.error = () => undefined;
  try {
    assert.doesNotThrow(() => persistContextCompactionCountSafely('session-1', { threadId: 'thread-1', turnId: 'turn-1' }, () => {
      throw new Error('disk full');
    }));
  } finally {
    console.error = originalError;
  }
});

test('缺少 Codex 事件身份时不猜测幂等键也不递增', () => {
  let called = false;
  persistContextCompactionCountSafely('session-1', {}, () => { called = true; });
  assert.equal(called, false);
});
