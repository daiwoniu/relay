import assert from 'node:assert/strict';
import test from 'node:test';
import { getApprovalCardModel } from './approval-card-model.ts';

const approval = {
  id: 'approval-1',
  sessionId: '11111111-1111-4111-8111-111111111111',
  sessionTitle: '测试会话',
  kind: 'permissions_approval',
  title: '需要授予额外权限',
  summary: '需要访问网络',
  details: { reason: '需要访问网络' },
  availableActions: ['accept', 'accept_for_session', 'decline'],
  createdAt: 1,
};
const approvalKey = `${approval.sessionId}::${approval.id}`;

test('卡片模型生成授权目的、序号和类型文案', () => {
  const model = getApprovalCardModel({ approval, approvalKey, orderedIds: [approvalKey, `${approval.sessionId}::approval-2`], connected: true, submitting: false, detailsExpanded: false });
  assert.equal(model.positionLabel, '1 / 2');
  assert.equal(model.kindLabel, '权限');
  assert.equal(model.purpose, '需要访问网络');
  assert.equal(model.summary, '需要访问网络');
  assert.equal(model.canAccept, true);
  assert.equal(model.canDecline, true);
  assert.equal(model.canAcceptForSession, true);
  assert.equal(model.showAcceptForSession, true);
  assert.equal(getApprovalCardModel({ approval, approvalKey, orderedIds: [approvalKey], connected: true, submitting: false, detailsExpanded: true }).showAcceptForSession, true);
});

test('断线或提交中禁用响应但保留详情与跳转', () => {
  const offline = getApprovalCardModel({ approval, approvalKey, orderedIds: [approvalKey], connected: false, submitting: false, detailsExpanded: false });
  assert.equal(offline.responsesDisabled, true);
  assert.equal(offline.canViewDetails, true);
  assert.equal(offline.canNavigate, true);
  const submitting = getApprovalCardModel({ approval, approvalKey, orderedIds: [approvalKey], connected: true, submitting: true, detailsExpanded: false });
  assert.equal(submitting.responsesDisabled, true);
});

test('MCP 提醒保留独立展示并由通知卡提供响应操作', () => {
  const mcpApproval = {
    ...approval,
    kind: 'mcp_elicitation',
    title: '工具需要补充信息',
    summary: '工具需要补充信息：请选择发布环境',
    details: { message: '请选择发布环境' },
    availableActions: [],
  };
  const model = getApprovalCardModel({ approval: mcpApproval, approvalKey, orderedIds: [approvalKey], connected: true, submitting: false, detailsExpanded: false });
  assert.equal(model.kindLabel, 'MCP');
  assert.equal(model.purpose, '请选择发布环境');
  assert.equal(model.hasVisibleActions, false);
});
