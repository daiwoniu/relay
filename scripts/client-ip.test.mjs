import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeClientIp, lastForwardedIp, resolveProxyClientIp, resolveBackendClientIp } from './lib/client-ip.mjs';

test('IPv4、IPv6和映射地址标准化，拒绝非IP及携带端口的值', () => {
  assert.equal(normalizeClientIp(' ::FFFF:127.0.0.1 '), '127.0.0.1');
  assert.equal(normalizeClientIp('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(normalizeClientIp('0:0:0:0:0:0:0:1'), '::1');
  assert.equal(normalizeClientIp('2001:DB8::1'), '2001:db8::1');
  for (const value of ['unknown', '203.0.113.1:80', '[::1]', 'fe80::1%eth0', '', undefined]) assert.equal(normalizeClientIp(value), undefined);
});

test('只采用受信代理追加的最后一项，不将伪造前缀或非法末项升级为来源', () => {
  assert.equal(lastForwardedIp('malicious-input, 203.0.113.9'), '203.0.113.9');
  assert.equal(lastForwardedIp(['198.51.100.1', '203.0.113.9']), '203.0.113.9');
  for (const value of ['203.0.113.9, bad', '203.0.113.9,', '1'.repeat(4097), Array(33).fill('203.0.113.9').join(',')]) {
    assert.equal(lastForwardedIp(value), undefined);
  }
});

test('代理IP与精确公网Host必须同时匹配，缺失或畸形XFF回退直接连接地址', () => {
  const trusted = ['127.0.0.1', '::1'];
  assert.equal(resolveProxyClientIp('::ffff:127.0.0.1', '198.51.100.1, 203.0.113.9', trusted, true), '203.0.113.9');
  assert.equal(resolveProxyClientIp('::1', '2001:db8::9', trusted, true), '2001:db8::9');
  assert.equal(resolveProxyClientIp('192.168.1.8', '203.0.113.9', trusted, true), '192.168.1.8');
  assert.equal(resolveProxyClientIp('127.0.0.1', '203.0.113.9', trusted, false), '127.0.0.1');
  assert.equal(resolveProxyClientIp('127.0.0.1', '203.0.113.9', [], true), '127.0.0.1');
  assert.equal(resolveProxyClientIp('127.0.0.1', undefined, trusted, true), '127.0.0.1');
  assert.equal(resolveProxyClientIp('127.0.0.1', '203.0.113.9, bad', trusted, true), '127.0.0.1');
  assert.equal(resolveProxyClientIp(undefined, '203.0.113.9', trusted, true), undefined);
});

test('后端仅在本机网关连接上采用单个内部IP，远端/未知对端不能伪造', () => {
  assert.equal(resolveBackendClientIp('::ffff:127.0.0.1', '203.0.113.9'), '203.0.113.9');
  assert.equal(resolveBackendClientIp('::1', '::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(resolveBackendClientIp('192.168.1.8', '203.0.113.9'), '192.168.1.8');
  assert.equal(resolveBackendClientIp(undefined, '203.0.113.9'), 'local');
  assert.equal(resolveBackendClientIp('127.0.0.1', '203.0.113.9, 198.51.100.1'), '127.0.0.1');
  assert.equal(resolveBackendClientIp('127.0.0.1', ['203.0.113.9', '198.51.100.1']), '127.0.0.1');
});
