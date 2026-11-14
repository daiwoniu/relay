import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRelayConfig } from '../../scripts/lib/relay-config.mjs';
import {
  extractAccessToken,
  isAllowedOrigin,
  isSecureRelayRequest,
  isTrustedForwardedHttps,
  isValidAccessToken,
} from './security.js';

const configText = (publicAddresses = '') => `CODEX_HOST=127.0.0.1
CODEX_PORT=9281
BACKEND_LISTEN_HOST=0.0.0.0
BACKEND_LISTEN_PORT=9181
FRONTEND_LISTEN_HOST=0.0.0.0
FRONTEND_LISTEN_PORT=9081
PUBLIC_ALLOWED_ADDRESSES=${publicAddresses}`;

test('只允许本机、私网和显式配置的 Origin', () => {
  assert.equal(isAllowedOrigin('http://localhost:9081'), true);
  assert.equal(isAllowedOrigin('http://192.168.10.20:9081'), true);
  assert.equal(isAllowedOrigin('https://relay.example.com', 'https://relay.example.com'), true);
  assert.equal(isAllowedOrigin('https://evil.example.com'), false);
  assert.equal(isAllowedOrigin('not-a-url'), false);
});

test('统一配置只允许精确公网 HTTPS Origin', () => {
  const config = parseRelayConfig(configText('relay.example.test:41423'));
  assert.equal(isAllowedOrigin('https://relay.example.test:41423', '', config), true);
  assert.equal(isAllowedOrigin('https://relay.example.test', '', config), false);
  assert.equal(isAllowedOrigin('http://relay.example.test:41423', '', config), false);
});

test('只有精确公网 Host 的可信转发头会标记安全请求', () => {
  const config = parseRelayConfig(configText('relay.example.test:41423'));
  assert.equal(isTrustedForwardedHttps('https', 'relay.example.test:41423', config, false), true);
  assert.equal(isTrustedForwardedHttps('https', 'evil.example', config, false), false);
  assert.equal(isTrustedForwardedHttps('http', 'relay.example.test:41423', config, false), false);
  assert.equal(isSecureRelayRequest('http://localhost:9181/api/auth/login', 'https', 'relay.example.test:41423', config, false), true);
  assert.equal(isSecureRelayRequest('http://localhost:9181/api/auth/login', 'https', 'evil.example', config, false), false);
});

test('显式 RELAY_TRUST_PROXY 兼容模式仍可信任 HTTPS 转发', () => {
  const config = parseRelayConfig(configText());
  assert.equal(isTrustedForwardedHttps('https', 'legacy.example', config, true), true);
});

test('访问令牌使用恒定时间比较并支持未配置兼容模式', () => {
  assert.equal(isValidAccessToken(null, ''), true);
  assert.equal(isValidAccessToken('secret', 'secret'), true);
  assert.equal(isValidAccessToken('wrong', 'secret'), false);
  assert.equal(isValidAccessToken(null, 'secret'), false);
});

test('令牌提取优先 Bearer，其次自定义头和 query', () => {
  assert.equal(extractAccessToken('Bearer first', 'second', 'third'), 'first');
  assert.equal(extractAccessToken(null, 'second', 'third'), 'second');
  assert.equal(extractAccessToken(null, null, 'third'), 'third');
});
