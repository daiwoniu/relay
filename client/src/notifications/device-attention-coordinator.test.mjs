import assert from 'node:assert/strict';
import test from 'node:test';
import { coordinateDeviceAttention, selectDeviceAttentionOwner } from './device-attention-coordinator.ts';

test('任一标签页正在处理目标内容时整台设备抑制提醒', () => {
  assert.equal(selectDeviceAttentionOwner([
    { tabId: 'tab-b', suppress: false },
    { tabId: 'tab-a', suppress: true },
  ]), null);
});

test('全部标签页均在后台时稳定选出一个提醒执行者', () => {
  assert.equal(selectDeviceAttentionOwner([
    { tabId: 'tab-c', suppress: false },
    { tabId: 'tab-a', suppress: false },
    { tabId: 'tab-b', suppress: false },
  ]), 'tab-a');
});

test('不支持跨标签页通道时沿用当前标签页判断', async () => {
  assert.equal(await coordinateDeviceAttention('event-1', false), true);
  assert.equal(await coordinateDeviceAttention('event-2', true), false);
});
