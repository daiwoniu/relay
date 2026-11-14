import assert from 'node:assert/strict';
import test from 'node:test';
import { upsertProcessStep } from './process-steps.ts';

function step(status, details = {}) {
  return { id: 'item-1', type: 'commandExecution', status, details };
}

test('同一处理项的快照和实时事件只保留一份', () => {
  const initial = upsertProcessStep([], [], step('in_progress', { command: 'rtk git status' }));
  const repeated = upsertProcessStep(initial.processSteps, initial.blocks, step('in_progress', { cwd: 'D:\\relay' }));

  assert.equal(repeated.processSteps.length, 1);
  assert.equal(repeated.blocks.filter((block) => block.type === 'step').length, 1);
  assert.deepEqual(repeated.processSteps[0].details, { command: 'rtk git status', cwd: 'D:\\relay' });
});

test('完成事件会合并并清理已有的同 ID 副本', () => {
  const duplicate = step('in_progress', { command: 'rtk git diff --stat' });
  const blocks = [
    { type: 'step', step: duplicate },
    { type: 'text', content: '处理中' },
    { type: 'step', step: duplicate },
  ];
  const result = upsertProcessStep(
    [duplicate, duplicate],
    blocks,
    step('completed', { durationMs: 3700 }),
  );

  assert.equal(result.processSteps.length, 1);
  assert.equal(result.processSteps[0].status, 'completed');
  assert.equal(result.blocks.filter((block) => block.type === 'step').length, 1);
  assert.deepEqual(result.processSteps[0].details, { command: 'rtk git diff --stat', durationMs: 3700 });
});
