import assert from 'node:assert/strict';
import test from 'node:test';
import { getQueueStartAttentionDecision } from './queue-start-policy.ts';
import { selectDeviceAttentionOwner } from './device-attention-coordinator.ts';

test('当前前台会话不发系统通知也不播放声音', () => {
  const result = getQueueStartAttentionDecision({ pageVisible: true, windowFocused: true, activeSessionId: 's1', eventSessionId: 's1', systemEnabled: true, systemSupported: true, systemPermission: 'granted', soundEnabled: true });
  assert.equal(result.sendSystemNotification, false);
  assert.equal(result.playSound, false);
  assert.equal(result.suppressLocally, true);
});

test('同 queue ID 多标签只选一个 owner，任一前台标签可整体抑制', () => {
  assert.equal(selectDeviceAttentionOwner([{ tabId: 'b', suppress: false }, { tabId: 'a', suppress: false }]), 'a');
  assert.equal(selectDeviceAttentionOwner([{ tabId: 'b', suppress: false }, { tabId: 'a', suppress: true }]), null);
});
