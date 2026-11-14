import assert from 'node:assert/strict';
import test from 'node:test';
import { taskStatusPresentation } from './task-status.ts';

test('task status aliases share labels and colors without merging distinct outcomes', () => {
  for (const [alias, canonical] of [
    ['active', 'doing'], ['in_progress', 'doing'], ['review', 'review_pending'],
    ['completed', 'done'], ['canceled', 'cancelled'],
  ]) {
    assert.deepEqual(taskStatusPresentation(alias), taskStatusPresentation(canonical));
  }
  assert.notEqual(taskStatusPresentation('waiting').tone, taskStatusPresentation('done').tone);
  assert.notEqual(taskStatusPresentation('blocked').tone, taskStatusPresentation('waiting').tone);
  assert.notEqual(taskStatusPresentation('done').tone, taskStatusPresentation('closed').tone);
  assert.notEqual(taskStatusPresentation('review_pending').tone, taskStatusPresentation('doing').tone);
  assert.match(taskStatusPresentation('doing').tone, /workspace-workbench__status-doing/);
});

test('unknown task statuses remain visible with a neutral color', () => {
  assert.equal(taskStatusPresentation(null).label, '状态未登记');
  assert.equal(taskStatusPresentation('custom').label, 'custom');
  assert.equal(taskStatusPresentation(null).tone, taskStatusPresentation('custom').tone);
});
