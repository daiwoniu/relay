import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRuntimeState } from '../engine/runtime.js';
import { projectStoredRecoverySnapshot } from './stored-runtime-recovery.js';

test('恢复更新内容与状态但保留已有记录时间，不为恢复中新出现的事件补算时间', async () => {
  const runtime = createSessionRuntimeState({ sessionId: 'session', projectId: 'project', engine: 'codex' });
  runtime.turnItems = [{ id: 'tool', type: 'commandExecution', status: 'in_progress', details: { command: 'echo old', firstObservedAt: 100, startedObservedAt: 100 } }];
  runtime.processTimeline = [{ type: 'narrative', itemId: 'intro', content: 'old', firstObservedAt: 50 }];
  const context = {
    guard: { assertCurrent() {}, isCurrent: () => true },
    fact: { factType: 'recovery_completed', source: 'recovery' },
  } as unknown as Parameters<typeof projectStoredRecoverySnapshot>[2];
  await projectStoredRecoverySnapshot(runtime, {
    type: 'recovery_snapshot', turnId: 'turn', status: 'completed', content: 'answer', waitingOnInteraction: false,
    items: [{ id: 'tool', type: 'commandExecution', status: 'completed', details: { command: 'echo recovered', output: 'result' } }, { id: 'new', type: 'plan', status: 'completed' }],
    processTimeline: [{ type: 'narrative', itemId: 'intro', content: 'recovered' }, { type: 'operation', itemId: 'tool' }],
  }, context);
  assert.equal(runtime.turnItems[0]!.status, 'completed');
  assert.equal((runtime.turnItems[0]!.details as any).command, 'echo recovered');
  assert.equal((runtime.turnItems[0]!.details as any).firstObservedAt, 100);
  assert.equal((runtime.turnItems[0]!.details as any).startedObservedAt, 100);
  assert.equal((runtime.turnItems[0]!.details as any).completedObservedAt, undefined);
  assert.equal((runtime.turnItems[1]!.details as any)?.firstObservedAt, undefined);
  assert.equal((runtime.processTimeline[0] as any).firstObservedAt, 50);
  assert.equal((runtime.processTimeline[0] as any).content, 'recovered');
});
