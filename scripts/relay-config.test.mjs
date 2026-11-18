import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatPublicAccessStatus,
  getRelayServicePorts,
  isAllowedRequestHost,
  isConfiguredPublicHost,
  isLocalOrPrivateHost,
  isPublicOriginAllowed,
  parseRelayConfig,
} from './lib/relay-config.mjs';

const configText = (publicAddresses = '', codexHost = '127.0.0.1', codexPort = '9281', backendHost = '0.0.0.0', backendPort = '9181', frontendHost = '0.0.0.0', frontendPort = '9081') => `
CODEX_HOST=${codexHost}
CODEX_PORT=${codexPort}
BACKEND_LISTEN_HOST=${backendHost}
BACKEND_LISTEN_PORT=${backendPort}
FRONTEND_LISTEN_HOST=${frontendHost}
FRONTEND_LISTEN_PORT=${frontendPort}
PUBLIC_ALLOWED_ADDRESSES=${publicAddresses}
`;

test('空配置保持公网访问关闭', () => {
  const config = parseRelayConfig(configText());
  assert.equal(config.publicAccess.enabled, false);
  assert.equal(config.publicAccess.wildcard, false);
  assert.deepEqual(config.publicAccess.addresses, []);
  assert.equal(isPublicOriginAllowed('https://example.com', config), false);
  assert.deepEqual(config.codex, {
    host: '127.0.0.1',
    port: 9281,
    authority: '127.0.0.1:9281',
    wsUrl: 'ws://127.0.0.1:9281',
    readyUrl: 'http://127.0.0.1:9281/readyz',
  });
  assert.deepEqual(config.backend, {
    listenHost: '0.0.0.0', port: 9181, listenAuthority: '0.0.0.0:9181',
    connectHost: '127.0.0.1', authority: '127.0.0.1:9181', origin: 'http://127.0.0.1:9181',
  });
  assert.deepEqual(config.frontend, {
    listenHost: '0.0.0.0', port: 9081, listenAuthority: '0.0.0.0:9081',
    connectHost: '127.0.0.1', authority: '127.0.0.1:9081', origin: 'http://127.0.0.1:9081',
  });
  assert.deepEqual(getRelayServicePorts(config), [9281, 9181, 9081]);
});

test('Relay 监听端点支持 IPv4、IPv6，并为通配地址派生回环连接地址', () => {
  const ipv4 = parseRelayConfig(configText('', '127.0.0.1', '9181', '192.168.1.8', '19082', '127.0.0.1', '19083'));
  assert.equal(ipv4.backend.origin, 'http://192.168.1.8:19082');
  assert.equal(ipv4.frontend.origin, 'http://127.0.0.1:19083');

  const ipv6 = parseRelayConfig(configText('', '::1', '19181', '::', '19082', '0:0:0:0:0:0:0:0', '19083'));
  assert.equal(ipv6.backend.listenAuthority, '[::]:19082');
  assert.equal(ipv6.backend.origin, 'http://[::1]:19082');
  assert.equal(ipv6.frontend.origin, 'http://[::1]:19083');
});

test('Relay 监听端点要求显式有效 IP、有效端口且端口互不冲突', () => {
  assert.throws(() => parseRelayConfig(configText().replace('BACKEND_LISTEN_HOST=0.0.0.0\n', '')), /缺少配置项：BACKEND_LISTEN_HOST/);
  for (const host of ['', 'localhost', 'example.com']) {
    assert.throws(() => parseRelayConfig(configText('', '127.0.0.1', '9181', host)), /后端监听 IP 无效/);
  }
  for (const port of ['', '0', '65536', 'abc', '9082.5']) {
    assert.throws(() => parseRelayConfig(configText('', '127.0.0.1', '9181', '0.0.0.0', port)), /后端监听端口无效/);
  }
  assert.throws(() => parseRelayConfig(configText('', '127.0.0.1', '9181', '0.0.0.0', '9181')), /监听端口不能重复/);
});

test('解析域名、IPv4、默认端口和多个地址', () => {
  const config = parseRelayConfig(`
    # 注释
    CODEX_HOST=127.0.0.1
    CODEX_PORT=9281
    BACKEND_LISTEN_HOST=0.0.0.0
    BACKEND_LISTEN_PORT=9181
    FRONTEND_LISTEN_HOST=0.0.0.0
    FRONTEND_LISTEN_PORT=9081
    PUBLIC_ALLOWED_ADDRESSES=relay.example.test:41423, Example.com, 203.0.113.8:8443
  `);

  assert.deepEqual(config.publicAccess.addresses, [
    { hostname: 'relay.example.test', port: 41423, authority: 'relay.example.test:41423', origin: 'https://relay.example.test:41423' },
    { hostname: 'example.com', port: 443, authority: 'example.com', origin: 'https://example.com' },
    { hostname: '203.0.113.8', port: 8443, authority: '203.0.113.8:8443', origin: 'https://203.0.113.8:8443' },
  ]);
  assert.equal(isConfiguredPublicHost('relay.example.test:41423', config), true);
  assert.equal(isConfiguredPublicHost('relay.example.test:443', config), false);
  assert.equal(isPublicOriginAllowed('https://example.com', config), true);
  assert.equal(isPublicOriginAllowed('http://example.com', config), false);
});

test('0.0.0.0 单独启用危险通配模式', () => {
  const config = parseRelayConfig(configText('0.0.0.0'));
  assert.equal(config.publicAccess.enabled, true);
  assert.equal(config.publicAccess.wildcard, true);
  assert.equal(isConfiguredPublicHost('anything.example:9443', config), true);
  assert.equal(isPublicOriginAllowed('https://anything.example:9443', config), true);
  assert.match(formatPublicAccessStatus(config).join('\n'), /任意公网地址/);
});

test('本机和私有地址不依赖公网配置', () => {
  const config = parseRelayConfig(configText());
  for (const host of ['localhost:9081', '127.0.0.1:9081', '[::1]:9081', '192.168.10.20:9081', '10.0.0.2', '172.16.0.1']) {
    assert.equal(isLocalOrPrivateHost(host), true, host);
    assert.equal(isAllowedRequestHost(host, config), true, host);
  }
  assert.equal(isAllowedRequestHost('public.example:9081', config), false);
});

test('拒绝重复键、未知键、混合通配和非法地址', () => {
  assert.throws(() => parseRelayConfig(`${configText('a.example')}\nPUBLIC_ALLOWED_ADDRESSES=b.example`), /重复配置项/);
  assert.throws(() => parseRelayConfig(`${configText()}\nUNKNOWN=value`), /未知配置项/);
  assert.throws(() => parseRelayConfig(configText('0.0.0.0,a.example')), /不能与其他地址混用/);
  for (const value of ['https://example.com', 'example.com/path', 'user@example.com', 'example.com:70000', '*.example.com']) {
    assert.throws(() => parseRelayConfig(configText(value)), /公网地址格式无效|端口无效/);
  }
});

test('Codex 端点要求显式回环 IP 与有效端口', () => {
  assert.throws(() => parseRelayConfig('CODEX_PORT=9181\nPUBLIC_ALLOWED_ADDRESSES='), /缺少配置项：CODEX_HOST/);
  assert.throws(() => parseRelayConfig('CODEX_HOST=127.0.0.1\nPUBLIC_ALLOWED_ADDRESSES='), /缺少配置项：CODEX_PORT/);
  for (const host of ['localhost', '0.0.0.0', '192.168.1.2', 'example.com']) {
    assert.throws(() => parseRelayConfig(configText('', host)), /Codex IP 必须是回环地址/);
  }
  for (const port of ['', '0', '65536', 'abc', '9181.5']) {
    assert.throws(() => parseRelayConfig(configText('', '127.0.0.1', port)), /Codex 端口/);
  }
});

test('Codex IPv6 回环地址生成带方括号的 URL', () => {
  const config = parseRelayConfig(configText('', '::1', '9281'));
  assert.equal(config.codex.authority, '[::1]:9281');
  assert.equal(config.codex.wsUrl, 'ws://[::1]:9281');
  assert.equal(config.codex.readyUrl, 'http://[::1]:9281/readyz');
});

test('状态输出列出精确HTTPS地址', () => {
  const config = parseRelayConfig(configText('relay.example.test:41423'));
  assert.deepEqual(formatPublicAccessStatus(config), [
    '公网访问：已启用',
    '  https://relay.example.test:41423',
  ]);
});

test('可信代理默认关闭，只接受精确IP且不能搭配公网通配模式', () => {
  assert.deepEqual(parseRelayConfig(configText()).trustedProxyIps, []);
  const config = parseRelayConfig(configText('relay.example:443') + '\nTRUSTED_PROXY_IPS=127.0.0.1,::ffff:127.0.0.1,0:0:0:0:0:0:0:1');
  assert.deepEqual(config.trustedProxyIps, ['127.0.0.1', '::1']);
  for (const value of ['localhost', '*', '0.0.0.0', '::', '127.0.0.1/8', '127.0.0.1:9081', 'bad']) {
    assert.throws(() => parseRelayConfig(configText('relay.example:443') + '\nTRUSTED_PROXY_IPS=' + value), /TRUSTED_PROXY_IPS/);
  }
  assert.throws(() => parseRelayConfig(configText('0.0.0.0') + '\nTRUSTED_PROXY_IPS=127.0.0.1'), /精确地址/);
});
