import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageOrigin, createMessageOriginForClient, resolveWebSocketClientIp } from './message-origin.js';

test('WebSocket 来源优先采用可信本机网关记录的客户端地址', () => {
  assert.equal(resolveWebSocketClientIp({
    remoteAddress: '::ffff:127.0.0.1', relayClientAddress: '192.168.1.108',
  }), '192.168.1.108');
  assert.equal(resolveWebSocketClientIp({
    remoteAddress: '203.0.113.8', relayClientAddress: '192.168.1.108',
  }), '203.0.113.8');
});

test('无效代理地址不会覆盖服务端连接地址', () => {
  assert.equal(resolveWebSocketClientIp({
    remoteAddress: '::1', relayClientAddress: 'not-an-ip',
  }), '::1');
});

test('消息来源使用认证用户和服务端接收事实', () => {
  const origin = createMessageOrigin({
    user: { id: 'u1', username: 'xiang', displayName: '祥哥', role: 'admin', avatarUpdatedAt: null, defaultProjectId: null, defaultEngine: 'codex', defaultModelId: null, mustChangePassword: false, disabledAt: null },
    ip: '192.168.1.108', receivedAt: 123,
    client: { source: 'web', deviceType: 'desktop', osName: 'Windows', browserName: 'Edge', relayVersion: '0.19.0' },
  });
  assert.deepEqual(origin, {
    senderUserId: 'u1', senderUsername: 'xiang', senderDisplayName: '祥哥', ip: '192.168.1.108', receivedAt: 123,
    client: { source: 'web', deviceType: 'desktop', osName: 'Windows', browserName: 'Edge', relayVersion: '0.19.0' },
  });
});

test('旧客户端未上报环境时不伪造设备来源', () => {
  const origin = createMessageOriginForClient({
    user: { id: 'u1', username: 'xiang', displayName: '祥哥', role: 'admin', avatarUpdatedAt: null, defaultProjectId: null, defaultEngine: 'codex', defaultModelId: null, mustChangePassword: false, disabledAt: null },
    ip: '192.168.1.108',
  }, undefined, 123);
  assert.equal(origin.client, undefined);
});
