import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getApprovalResultLabel, getApprovalSourceLabel } from '../messages/interaction-model.ts';

test('结果位只陈述操作结局，引擎侧结束不冒充结果', () => {
  assert.equal(getApprovalResultLabel({ resolvedAction: 'accept' }), '已允许');
  assert.equal(getApprovalResultLabel({ resolvedAction: 'accept_for_session' }), '本会话已允许');
  assert.equal(getApprovalResultLabel({ resolvedAction: 'decline' }), '已拒绝');
  assert.equal(getApprovalResultLabel({ resolvedAction: 'cancel' }), '已取消');
  assert.equal(getApprovalResultLabel({ resolvedAction: 'submit' }), '已提交');
  assert.equal(getApprovalResultLabel({ resolvedAction: 'invalidated' }), '已失效');
  assert.equal(getApprovalResultLabel({ resolvedAction: 'resolved_elsewhere' }), '结果未记录');
  assert.equal(getApprovalResultLabel({}), null);
  assert.equal(getApprovalResultLabel({ status: 'pending' }), null);
});

test('来源位按设备标识比对区分由你与其他设备', () => {
  const details = { resolvedAction: 'accept', decisionSource: 'user', decidedByDeviceId: 'device-a', decidedByDeviceType: 'phone' };
  assert.equal(getApprovalSourceLabel(details, 'device-a'), '由你');
  assert.equal(getApprovalSourceLabel(details, 'device-b'), '由其他设备（手机）');
  assert.equal(
    getApprovalSourceLabel({ ...details, decidedByDeviceType: 'desktop' }, 'device-b'),
    '由其他设备（电脑）',
  );
  assert.equal(
    getApprovalSourceLabel({ ...details, decidedByDeviceType: null }, 'device-b'),
    '由其他设备',
  );
  // 旧票据没有设备标识时按本账号操作降级为“由你”
  assert.equal(getApprovalSourceLabel({ resolvedAction: 'decline', decisionSource: 'user' }, 'device-b'), '由你');
  // 本机存储不可用（localDeviceId 为 null）时无法比对，同样不猜成其他设备
  assert.equal(getApprovalSourceLabel(details, null), '由你');
});

test('自动允许与引擎侧结束按来源展示，未知来源不显示', () => {
  assert.equal(getApprovalSourceLabel({ resolvedAction: 'accept', decisionSource: 'session_trust' }, 'device-a'), '由会话信任自动允许');
  assert.equal(getApprovalSourceLabel({ resolvedAction: 'accept', decisionSource: 'project_trust' }, 'device-a'), '由项目信任自动允许');
  assert.equal(
    getApprovalSourceLabel({ resolvedAction: 'resolved_elsewhere', decisionSource: 'resolved_elsewhere' }, 'device-a'),
    '由引擎侧结束',
  );
  assert.equal(getApprovalSourceLabel({ resolvedAction: 'accept' }, 'device-a'), null);
  assert.equal(getApprovalSourceLabel({ resolvedAction: 'accept', decisionSource: 'unknown' }, 'device-a'), null);
  assert.equal(getApprovalSourceLabel({ command: 'decisionSource=session_trust', status: 'pending' }, 'device-a'), null);
});

test('交互面板结果与来源各占一位不再拼接', async () => {
  const source = await readFile(new URL('../messages/InteractionPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /getApprovalResultLabel\(details\)/);
  assert.match(source, /getApprovalSourceLabel\(details, getDeviceId\(\) \|\| null\)/);
  assert.match(source, /决定来源：\{decisionSourceLabel\}/);
  assert.doesNotMatch(source, /getApprovalDecisionSourceLabel/);
  assert.doesNotMatch(source, /已在其他设备处理/);
  assert.match(source, /text-\[var\(--color-text-tertiary\)\]/);
});
