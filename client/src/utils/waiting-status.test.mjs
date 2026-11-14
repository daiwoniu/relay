import assert from 'node:assert/strict';
import test from 'node:test';
import { getWaitingStatusLabel } from './waiting-status.ts';

test('等待阶段使用明确且连续的运行文案', () => {
  assert.equal(getWaitingStatusLabel('submitted'), '消息发送中');
  assert.equal(getWaitingStatusLabel('forwarded'), '正在启动');
  assert.equal(getWaitingStatusLabel('started'), '处理中');
});
