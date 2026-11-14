import assert from 'node:assert/strict';
import test from 'node:test';
import { getBatchApprovalDialogPresentation } from './batch-approval-dialog-state.ts';

test('确认态展示冻结说明和对应操作语义', () => {
  const accept = getBatchApprovalDialogPresentation({ action: 'accept', status: 'confirming', requestCount: 4 });

  assert.equal(accept.tone, 'accept');
  assert.equal(accept.icon, 'accept');
  assert.equal(accept.title, '批量通过请求');
  assert.match(accept.description, /确认后/);
  assert.equal(accept.confirmLabel, '通过 4 项请求');
});

test('提交态不再显示执行前说明', () => {
  const presentation = getBatchApprovalDialogPresentation({ action: 'accept', status: 'submitting', requestCount: 5, processed: 2 });

  assert.equal(presentation.eyebrow, '正在逐项处理');
  assert.equal(presentation.title, '正在批量通过');
  assert.match(presentation.description, /已处理 2 \/ 5 项/);
  assert.doesNotMatch(presentation.description, /确认后/);
});

test('全部成功使用成功语义，失效或失败使用部分完成语义', () => {
  const success = getBatchApprovalDialogPresentation({ action: 'accept', status: 'complete', requestCount: 3, success: 3 });
  const partial = getBatchApprovalDialogPresentation({ action: 'accept', status: 'complete', requestCount: 3, success: 1, skipped: 1, failed: 1 });

  assert.equal(success.tone, 'success');
  assert.equal(success.title, '批量通过完成');
  assert.equal(success.impact, '全部请求均已处理成功');
  assert.equal(partial.tone, 'partial');
  assert.equal(partial.icon, 'warning');
  assert.equal(partial.title, '批量通过部分完成');
  assert.match(partial.description, /已失效 1 项，失败 1 项/);
});
