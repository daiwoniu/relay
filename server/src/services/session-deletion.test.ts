import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionDeletionCoordinator } from './session-deletion.js';

const session = {
  id: 'session-1',
  codex_thread_id: 'thread-1',
  codex_archived: 0,
  codex_archived_for_trash: 0,
};

test('SessionDeletionCoordinator 按中断、归档、标记和关闭顺序准备删除', async () => {
  const calls: string[] = [];
  const coordinator = createSessionDeletionCoordinator({
    runtime: {
      interruptSession: async (sessionId) => { calls.push(`interrupt:${sessionId}`); },
      closeSessionConnection: (sessionId) => { calls.push(`close:${sessionId}`); },
    },
    codexThreads: {
      archiveThread: async (threadId) => { calls.push(`archive:${threadId}`); return { wasAlreadyArchived: false }; },
    },
    persistence: {
      markThreadArchived: (sessionId, restoreOnRecovery) => { calls.push(`mark:${sessionId}:${restoreOnRecovery}`); },
    },
  });

  await coordinator.prepare(session, (stage) => { calls.push(`progress:${stage}`); });

  assert.deepEqual(calls, [
    'progress:stopping',
    'interrupt:session-1',
    'progress:archiving',
    'archive:thread-1',
    'mark:session-1:true',
    'close:session-1',
  ]);
});

test('SessionDeletionCoordinator 无 thread 时跳过归档，已标记归档时仍核验 Codex 实际状态', async () => {
  const calls: string[] = [];
  const coordinator = createSessionDeletionCoordinator({
    runtime: {
      interruptSession: async (sessionId) => { calls.push(`interrupt:${sessionId}`); },
      closeSessionConnection: (sessionId) => { calls.push(`close:${sessionId}`); },
    },
    codexThreads: {
      archiveThread: async (threadId) => { calls.push(`archive:${threadId}`); return { wasAlreadyArchived: true }; },
    },
    persistence: {
      markThreadArchived: (sessionId, restoreOnRecovery) => { calls.push(`mark:${sessionId}:${restoreOnRecovery}`); },
    },
  });

  await coordinator.prepare({ ...session, codex_thread_id: null }, (stage) => { calls.push(`progress:${stage}`); });
  await coordinator.prepare({ ...session, id: 'session-2', codex_archived: 1 }, (stage) => { calls.push(`progress:${stage}`); });

  assert.deepEqual(calls, [
    'progress:stopping',
    'interrupt:session-1',
    'close:session-1',
    'progress:stopping',
    'interrupt:session-2',
    'progress:archiving',
    'archive:thread-1',
    'mark:session-2:false',
    'close:session-2',
  ]);
});

test('SessionDeletionCoordinator 重复删除时保留尚未消费的恢复标记', async () => {
  const marked: boolean[] = [];
  const coordinator = createSessionDeletionCoordinator({
    runtime: { interruptSession: async () => undefined, closeSessionConnection: () => undefined },
    codexThreads: { archiveThread: async () => ({ wasAlreadyArchived: true }) },
    persistence: { markThreadArchived: (_sessionId, restoreOnRecovery) => marked.push(restoreOnRecovery) },
  });

  await coordinator.prepare({ ...session, codex_archived: 1, codex_archived_for_trash: 1 });

  assert.deepEqual(marked, [true]);
});

test('SessionDeletionCoordinator 中断失败时不归档或关闭', async () => {
  const calls: string[] = [];
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  const coordinator = createSessionDeletionCoordinator({
    runtime: {
      interruptSession: async () => { calls.push('interrupt'); throw new Error('interrupt failed'); },
      closeSessionConnection: () => { calls.push('close'); },
    },
    codexThreads: {
      archiveThread: async () => { calls.push('archive'); return { wasAlreadyArchived: false }; },
    },
    persistence: {
      markThreadArchived: () => { calls.push('mark'); },
    },
  });

  try {
    await assert.rejects(() => coordinator.prepare(session), /停止 Codex 任务失败，Relay 会话未删除/);
    assert.deepEqual(calls, ['interrupt']);
    assert.match(String(logged[0]?.[0]), /停止 Codex 任务失败：session-1/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('SessionDeletionCoordinator 归档失败时不标记或关闭', async () => {
  const calls: string[] = [];
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  const coordinator = createSessionDeletionCoordinator({
    runtime: {
      interruptSession: async () => { calls.push('interrupt'); },
      closeSessionConnection: () => { calls.push('close'); },
    },
    codexThreads: {
      archiveThread: async () => { calls.push('archive'); throw new Error('archive failed'); },
    },
    persistence: {
      markThreadArchived: () => { calls.push('mark'); },
    },
  });

  try {
    await assert.rejects(() => coordinator.prepare(session), /归档 Codex 会话失败，Relay 会话未删除/);
    assert.deepEqual(calls, ['interrupt', 'archive']);
    assert.match(String(logged[0]?.[0]), /归档 Codex 会话失败：session-1/);
  } finally {
    console.error = originalConsoleError;
  }
});
