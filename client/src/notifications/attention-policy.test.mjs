import assert from 'node:assert/strict';
import test from 'node:test';
import { getApprovalAttentionDecision, getApprovalPageTitle } from './attention-policy.ts';

const base = { source: 'live', pageVisible: true, windowFocused: true, systemEnabled: true, systemSupported: true, systemPermission: 'granted', soundEnabled: true };

test('页面可见且聚焦时只显示卡片', () => {
  assert.deepEqual(getApprovalAttentionDecision(base), { showCard: true, sendSystemNotification: false, playSound: false, updateTitle: true });
});

test('页面隐藏或失焦时允许系统通知和提示音', () => {
  assert.equal(getApprovalAttentionDecision({ ...base, pageVisible: false }).sendSystemNotification, true);
  assert.equal(getApprovalAttentionDecision({ ...base, windowFocused: false }).playSound, true);
});

test('快照、重复增量和恢复焦点均不触发提醒', () => {
  for (const source of ['snapshot', 'duplicate', 'focus']) {
    const decision = getApprovalAttentionDecision({ ...base, source, pageVisible: false });
    assert.equal(decision.showCard, false);
    assert.equal(decision.sendSystemNotification, false);
    assert.equal(decision.playSound, false);
  }
});

test('系统通知不可用时仍更新标题', () => {
  const decision = getApprovalAttentionDecision({ ...base, pageVisible: false, systemSupported: false, systemPermission: 'unsupported' });
  assert.equal(decision.sendSystemNotification, false);
  assert.equal(decision.updateTitle, true);
  assert.equal(getApprovalPageTitle(2, '原标题'), '[待处理 2] Relay');
  assert.equal(getApprovalPageTitle(0, '原标题'), '原标题');
});
