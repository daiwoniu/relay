import assert from 'node:assert/strict';
import test from 'node:test';

import { isSessionActionInProgress } from './session-action-state.ts';

test('进行中和处理中状态禁止破坏性会话操作', () => {
  for (const status of ['queued', 'pending', 'processing', 'recovering', 'awaiting_action', 'stopping']) {
    assert.equal(isSessionActionInProgress(status), true, status);
  }
});

test('终态和空闲状态允许会话操作', () => {
  for (const status of ['idle', 'completed', 'failed', 'stopped', 'interrupted']) {
    assert.equal(isSessionActionInProgress(status), false, status);
  }
});
