import assert from 'node:assert/strict';
import test from 'node:test';

import { isSessionInProgress } from './session-runtime-status.js';

test('会话运行态口径覆盖排队、处理、恢复、等待操作和停止中', () => {
  for (const status of ['queued', 'pending', 'processing', 'recovering', 'awaiting_action', 'stopping']) {
    assert.equal(isSessionInProgress(status), true, status);
  }
});

test('空闲及终态不阻止删除', () => {
  for (const status of ['idle', 'completed', 'failed', 'stopped', 'interrupted']) {
    assert.equal(isSessionInProgress(status), false, status);
  }
});
