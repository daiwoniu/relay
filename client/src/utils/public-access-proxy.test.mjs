import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { parseRelayConfig } from '../../../scripts/lib/relay-config.mjs';
import {
  applyShareDocumentHeaders,
  applyTrustedForwardedHeaders,
  configurePublicProxy,
  createPublicAccessPlugin,
  getAllowedHosts,
} from '../../vite-public-access.mjs';

const relayConfig = (publicAddresses) => parseRelayConfig([
  'CODEX_HOST=127.0.0.1',
  'CODEX_PORT=9281',
  'BACKEND_LISTEN_HOST=0.0.0.0',
  'BACKEND_LISTEN_PORT=9181',
  'FRONTEND_LISTEN_HOST=0.0.0.0',
  'FRONTEND_LISTEN_PORT=9081',
  `PUBLIC_ALLOWED_ADDRESSES=${publicAddresses}`,
].join('\n'));

function createProxyRequest(initial = {}) {
  const headers = new Map(Object.entries(initial).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    headers,
    removeHeader(name) { headers.delete(name.toLowerCase()); },
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
  };
}

test('精确公网 Host 注入可信 HTTPS 头并覆盖外部伪造头', () => {
  const config = relayConfig('relay.example.test:41423');
  const request = createProxyRequest({
    'x-forwarded-proto': 'http',
    'x-forwarded-host': 'evil.example',
    'x-forwarded-for': '203.0.113.9',
    'x-relay-client-address': 'spoofed',
  });
  assert.equal(applyTrustedForwardedHeaders(request, 'relay.example.test:41423', config, '192.0.2.10'), true);
  assert.equal(request.headers.get('x-forwarded-proto'), 'https');
  assert.equal(request.headers.get('x-forwarded-host'), 'relay.example.test:41423');
  assert.equal(request.headers.has('x-forwarded-for'), false);
  assert.equal(request.headers.get('x-relay-client-address'), '192.0.2.10');
});

test('本机请求不注入公网转发头，错误端口不匹配', () => {
  const config = relayConfig('relay.example.test:41423');
  const request = createProxyRequest({ 'x-forwarded-proto': 'https' });
  assert.equal(applyTrustedForwardedHeaders(request, 'localhost:9081', config), false);
  assert.equal(request.headers.has('x-forwarded-proto'), false);
  assert.equal(applyTrustedForwardedHeaders(request, 'relay.example.test:443', config), false);
  assert.deepEqual(getAllowedHosts(config), ['relay.example.test']);
});

test('通配模式交给 Vite 全 Host 放行', () => {
  assert.equal(getAllowedHosts(relayConfig('0.0.0.0')), true);
});

test('WebSocket 代理拒绝未允许 Host', () => {
  const config = relayConfig('relay.example.test:41423');
  const proxy = new EventEmitter();
  configurePublicProxy(proxy, config);
  let destroyed = false;
  proxy.emit('proxyReqWs', createProxyRequest(), { headers: { host: 'evil.example' } }, { destroy() { destroyed = true; } });
  assert.equal(destroyed, true);
});

test('Vite 中间件接受本机和精确公网 Host，拒绝未知公网 Host', () => {
  const config = relayConfig('relay.example.test:41423');
  let middleware;
  createPublicAccessPlugin(config).configureServer({
    middlewares: { use(handler) { middleware = handler; } },
  });

  for (const host of ['localhost:9081', '192.168.10.20:9081', 'relay.example.test:41423']) {
    let nextCalled = false;
    middleware({ headers: { host } }, {}, () => { nextCalled = true; });
    assert.equal(nextCalled, true, host);
  }

  let body = '';
  const response = {
    statusCode: 0,
    setHeader() {},
    end(value) { body = value; },
  };
  middleware({ headers: { host: 'evil.example' } }, response, () => assert.fail('不应放行'));
  assert.equal(response.statusCode, 403);
  assert.match(body, /拒绝/);
});

test('公开分享文档响应禁止索引、缓存和 Referer', () => {
  const headers = new Map();
  const response = { setHeader(name, value) { headers.set(name.toLowerCase(), value); } };

  assert.equal(applyShareDocumentHeaders({ url: '/share/abc?from=test' }, response), true);
  assert.equal(headers.get('x-robots-tag'), 'noindex, noarchive');
  assert.equal(headers.get('cache-control'), 'private, no-store');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');

  headers.clear();
  assert.equal(applyShareDocumentHeaders({ url: '/api/public/shares/abc' }, response), false);
  assert.equal(headers.size, 0);
});
