import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginSubmissionState,
  clearSubmissionState,
  getSubmissionPhase,
  updateSubmissionState,
} from './submission-state.ts';

test('发送状态只锁定发起发送的草稿', () => {
  const state = beginSubmissionState('draft-a', 'sending');

  assert.equal(getSubmissionPhase(state, 'draft-a'), 'sending');
  assert.equal(getSubmissionPhase(state, 'draft-b'), 'idle');
});

test('旧发送结束不能清除新草稿的发送状态', () => {
  const first = beginSubmissionState('draft-a', 'sending');
  const second = beginSubmissionState('draft-b', 'preparing-attachments');

  assert.equal(updateSubmissionState(second, 'draft-a', 'sending'), second);
  assert.equal(clearSubmissionState(second, 'draft-a'), second);
  assert.equal(getSubmissionPhase(clearSubmissionState(second, 'draft-a'), 'draft-b'), 'preparing-attachments');
  assert.equal(clearSubmissionState(second, 'draft-b'), null);
});

test('发送状态可以切换为正在核实结果', () => {
  const sending = beginSubmissionState('draft-a', 'sending');
  const verifying = updateSubmissionState(sending, 'draft-a', 'verifying');

  assert.equal(getSubmissionPhase(verifying, 'draft-a'), 'verifying');
});
