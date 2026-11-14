import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractRelaySession,
  loginAndStoreSession,
  loadAndVerifySession,
} from './lib/auth-session.mjs';

const secret = 'cookie-value-that-must-not-leak';
const baseConfig = {
  origin: 'http://localhost:9081',
  username: 'admin',
  edgePath: 'edge.exe',
  desktopViewport: { width: 1456, height: 819, deviceScaleFactor: 1 },
  mobileViewport: { width: 390, height: 844, deviceScaleFactor: 1 },
  timeouts: { startupMs: 15000, navigationMs: 30000, scenarioMs: 120000 },
};

function response(status, { body = {}, setCookies = [] } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      getSetCookie: () => setCookies,
      get: (name) => name.toLowerCase() === 'set-cookie' ? setCookies.join(', ') : null,
    },
    json: async () => body,
  };
}

test('从多个 Set-Cookie 中只提取 relay_session', () => {
  assert.deepEqual(extractRelaySession([
    'relay_client_id=client; Path=/; HttpOnly',
    `relay_session=${secret}; Path=/; HttpOnly; SameSite=Lax`,
  ]), { name: 'relay_session', value: secret });
  assert.throws(() => extractRelaySession(['relay_session=; Path=/']), /有效 relay_session/);
  assert.throws(() => extractRelaySession([`relay_session=${secret}\r\nInjected: yes`]), /有效 relay_session/);
});

test('登录成功只保存 DPAPI 密文和非敏感元数据', async () => {
  const writes = {};
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/api/auth/login')) {
      assert.deepEqual(JSON.parse(options.body), { username: 'admin', password: 'password-value', purpose: 'headless_acceptance' });
      assert.equal(options.headers['X-Relay-Acceptance'], 'headless-v1');
      return response(200, {
        body: { user: { id: 'u1', username: 'admin' }, expiresAt: Date.parse('2026-09-13T06:00:00.000Z') },
        setCookies: [`relay_session=${secret}; Path=/; HttpOnly`],
      });
    }
    assert.equal(url, 'http://localhost:9081/api/auth/me');
    assert.equal(options.headers.Cookie, `relay_session=${secret}`);
    return response(200, { body: { user: { id: 'u1', username: 'admin' } } });
  };
  const result = await loginAndStoreSession({
    config: baseConfig,
    password: 'password-value',
    fetchImpl,
    protect: async (value) => { assert.equal(value, secret); return 'encrypted-payload'; },
    writeSession: async (value) => { writes.session = value; },
    writeConfig: async (value) => { writes.config = value; },
    now: () => Date.parse('2026-08-14T06:00:00.000Z'),
  });
  assert.equal(writes.session, 'encrypted-payload');
  assert.equal(writes.config.username, 'admin');
  assert.equal(writes.config.expiresAt, '2026-09-13T06:00:00.000Z');
  assert.equal(JSON.stringify(writes).includes(secret), false);
  assert.equal(JSON.stringify(writes).includes('password-value'), false);
  assert.equal(result.username, 'admin');
});

test('登录 401、429、畸形 Cookie 和 origin 不一致均失败关闭', async () => {
  const common = {
    config: baseConfig,
    password: 'bad',
    protect: async () => 'encrypted',
    writeSession: async () => {},
    writeConfig: async () => {},
  };
  await assert.rejects(loginAndStoreSession({ ...common, fetchImpl: async () => response(401) }), /401/);
  await assert.rejects(loginAndStoreSession({ ...common, fetchImpl: async () => response(429) }), /429/);
  await assert.rejects(loginAndStoreSession({ ...common, fetchImpl: async () => response(200, { body: { expiresAt: Date.now() + 10000 }, setCookies: ['other=value'] }) }), /relay_session/);
  await assert.rejects(loginAndStoreSession({ ...common, expectedOrigin: 'http://127.0.0.1:9081', fetchImpl: async () => response(200) }), /origin 不一致/);
});

test('解密后调用 auth me 自检，过期、401 和 DPAPI 失败均不泄密', async () => {
  const config = { ...baseConfig, expiresAt: '2026-09-13T06:00:00.000Z', createdAt: '2026-08-14T06:00:00.000Z' };
  const verified = await loadAndVerifySession({
    config,
    readSession: async () => 'encrypted-payload',
    unprotect: async () => secret,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://localhost:9081/api/auth/me');
      assert.equal(options.headers.Cookie, `relay_session=${secret}`);
      return response(200, { body: { user: { id: 'u1', username: 'admin' } } });
    },
    now: () => Date.parse('2026-08-14T06:00:00.000Z'),
  });
  assert.equal(verified.cookieValue, secret);

  await assert.rejects(loadAndVerifySession({ ...verifiedDeps(config), now: () => Date.parse('2026-10-01T00:00:00.000Z') }), /已过期/);
  await assert.rejects(loadAndVerifySession({ ...verifiedDeps(config), fetchImpl: async () => response(401) }), /认证自检失败：401/);
  let message = '';
  try {
    await loadAndVerifySession({ ...verifiedDeps(config), unprotect: async () => { throw new Error(`DPAPI failed ${secret}`); } });
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /DPAPI 解密失败/);
  assert.doesNotMatch(message, new RegExp(secret));
});

function verifiedDeps(config) {
  return {
    config,
    readSession: async () => 'encrypted-payload',
    unprotect: async () => secret,
    fetchImpl: async () => response(200, { body: { user: { id: 'u1', username: 'admin' } } }),
    now: () => Date.parse('2026-08-14T06:00:00.000Z'),
  };
}
