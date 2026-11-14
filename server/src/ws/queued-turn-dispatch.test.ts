import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueueClaim } from '../engine/concurrency/repository.js';
import { QueuedTurnDispatcher } from './queued-turn-dispatch.js';

const claim: QueueClaim = {
  queue: {
    id: 'queue-1', sessionId: 'session-1', attemptId: 'attempt-1', userMessageId: 'message-1',
    engineId: 'codex', resourceKey: 'codex:default', requestedByUserId: 'user-1', state: 'claimed',
    claimToken: 'lease-1', createdAt: 1, claimedAt: 2,
  },
  lease: {
    attemptId: 'attempt-1', sessionId: 'session-1', engineId: 'codex', resourceKey: 'codex:default',
    leaseToken: 'lease-1', state: 'claimed', acquiredAt: 2, startedAt: null,
  },
};

test('dispatcher 从持久化消息和附件 metadata 重建输入且重复 claim token 只发送一次', async () => {
  const sent: string[] = [];
  const dispatcher = new QueuedTurnDispatcher({
    loadUserMessage: () => ({
      id: 'message-1', session_id: 'session-1', turn_id: 'attempt-1', role: 'user', content: '分析',
      phase: null, items: null, metadata: JSON.stringify({ attachments: [{
        id: '11111111-1111-4111-8111-111111111111', kind: 'host_file', name: 'a.txt', path: 'C:\\work\\a.txt', size: 1,
      }] }), created_at: 1, duration: null, stopped: 0,
    }),
    startTurn: ({ content }) => { sent.push(content); },
    failTurn: () => undefined,
  });
  await Promise.all([dispatcher.start(claim), dispatcher.start(claim)]);
  assert.deepEqual(sent, ['分析\n\n附件文件（Relay 主机绝对路径）：\n- C:\\work\\a.txt']);
  await dispatcher.start(claim);
  assert.deepEqual(sent, [
    '分析\n\n附件文件（Relay 主机绝对路径）：\n- C:\\work\\a.txt',
    '分析\n\n附件文件（Relay 主机绝对路径）：\n- C:\\work\\a.txt',
  ]);
});

test('dispatcher 启动同步抛错交给 scheduler 的 fail 收口', async () => {
  const failed: string[] = [];
  const dispatcher = new QueuedTurnDispatcher({
    loadUserMessage: () => ({ id: 'message-1', session_id: 'session-1', turn_id: 'attempt-1', role: 'user', content: '开始', phase: null, items: null, metadata: null, created_at: 1, duration: null, stopped: 0 }),
    startTurn: () => { throw new Error('boom'); },
    failTurn: (_claim, error) => { failed.push(error instanceof Error ? error.message : 'unknown'); },
  });
  await assert.rejects(dispatcher.start(claim), /boom/);
  await dispatcher.fail(claim, new Error('boom'));
  assert.deepEqual(failed, ['boom']);
});
