import assert from 'node:assert/strict';
import test from 'node:test';
import {
  disposeSessionSummaryRequest,
  isCurrentSessionSummaryRequest,
  replaceSessionSummaryRequest,
} from './session-summary-controller.ts';

test('A 切换到 B 时取消 A 且只允许 B 提交', () => {
  const requestA = replaceSessionSummaryRequest(null, 'session-a', 1);
  const requestB = replaceSessionSummaryRequest(requestA, 'session-b', 2);

  assert.equal(requestA.controller.signal.aborted, true);
  assert.equal(isCurrentSessionSummaryRequest(requestA, 'session-b', 2), false);
  assert.equal(isCurrentSessionSummaryRequest(requestB, 'session-b', 2), true);
  assert.equal(isCurrentSessionSummaryRequest(requestB, 'session-a', 2), false);
  assert.equal(isCurrentSessionSummaryRequest(requestB, 'session-b', 3), false);
});

test('组件卸载会取消当前标题请求', () => {
  const request = replaceSessionSummaryRequest(null, 'session-a', 1);
  disposeSessionSummaryRequest(request);
  assert.equal(request.controller.signal.aborted, true);
});
