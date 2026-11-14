import assert from 'node:assert/strict';
import test from 'node:test';
import { getPendingActionKind, resolveInteractionSessionStatus } from './frontend-runtime-policy.js';
import type { SessionRuntime } from '../engine/runtime.js';

test('处理单个交互后依据剩余请求汇总状态，停止状态优先', () => {
  const runtime = { isStopping: false, isRecovering: false, pendingInteractions: new Map() } as unknown as SessionRuntime;
  runtime.pendingInteractions.set('approval', { interaction: { kind: 'command' } } as never);
  runtime.pendingInteractions.set('question', { interaction: { kind: 'user_input' } } as never);
  assert.equal(getPendingActionKind(runtime), 'mixed');
  runtime.pendingInteractions.delete('approval');
  assert.equal(resolveInteractionSessionStatus(runtime), 'awaiting_action');
  assert.equal(getPendingActionKind(runtime), 'input');
  runtime.isStopping = true;
  assert.equal(resolveInteractionSessionStatus(runtime), 'stopping');
  runtime.isStopping = false;
  runtime.pendingInteractions.clear();
  assert.equal(resolveInteractionSessionStatus(runtime), 'processing');
  assert.equal(getPendingActionKind(runtime), null);
  runtime.isRecovering = true;
  assert.equal(resolveInteractionSessionStatus(runtime), 'recovering');
});
