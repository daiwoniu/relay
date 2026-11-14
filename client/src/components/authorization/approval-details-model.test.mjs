import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldShowApprovalReason } from './approval-details-model.ts';

test('摘要已经包含原因时不重复展示原因', () => {
  assert.equal(shouldShowApprovalReason('访问 API', '请求访问网络：访问 API'), false);
  assert.equal(shouldShowApprovalReason('读取配置', '读取配置'), false);
});

test('摘要与原因不同时保留补充说明', () => {
  assert.equal(shouldShowApprovalReason('仅用于检查更新', '请求访问网络'), true);
  assert.equal(shouldShowApprovalReason('', '请求访问网络'), false);
});
