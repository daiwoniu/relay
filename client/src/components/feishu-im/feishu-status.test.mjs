import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionStatus, deliveryStatus } from './feishu-status.ts';

test('区分主动停用、连接未启动和连接中的机器人', () => {
  assert.equal(connectionStatus(false, false, null).label, '已停用');
  assert.equal(connectionStatus(true, false, null).label, '连接未启动');
  assert.equal(connectionStatus(true, true, { state: 'reconnecting' }).label, '正在重连');
  assert.equal(connectionStatus(true, true, { state: 'connected' }).label, '已连接');
});

test('回复和主动通知共享发送状态，待处理和已拦截有明确文案', () => {
  assert.equal(deliveryStatus('sent').label, '已发送');
  assert.equal(deliveryStatus('unknown').label, '发送待确认');
  assert.equal(deliveryStatus(null, 'blocked').label, '已拦截');
  assert.equal(deliveryStatus(null).label, '待处理');
});
