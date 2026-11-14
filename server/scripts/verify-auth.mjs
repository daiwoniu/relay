import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const externalBaseUrl = process.env.RELAY_VERIFY_BASE_URL;
const port = 19085;
const baseUrl = externalBaseUrl || `http://127.0.0.1:${port}`;
const accessToken = process.env.RELAY_VERIFY_ACCESS_TOKEN || `relay-auth-${Date.now()}`;
const origin = process.env.RELAY_VERIFY_ORIGIN || 'http://localhost:9081';
const commonHeaders = { Origin: origin, 'X-Relay-Token': accessToken };

let child = null;
let tempDir = null;
let serverLog = '';

async function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { ...commonHeaders, ...(options.headers || {}) },
  });
}

function websocketUrl() {
  const url = new URL('/ws', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

async function expectWebSocketRejected() {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(websocketUrl(), { headers: commonHeaders });
    ws.once('open', () => reject(new Error('未登录 WebSocket 不应连接成功')));
    ws.once('unexpected-response', (_request, response) => {
      try {
        assert.equal(response.statusCode, 401);
        response.resume();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    ws.once('error', () => undefined);
  });
}

async function connectWebSocket(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(websocketUrl(), { headers: { ...commonHeaders, Cookie: cookie } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function waitForHealth() {
  for (let i = 0; i < 40; i += 1) {
    if (child && child.exitCode !== null) throw new Error(`认证验证服务提前退出：\n${serverLog}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`认证验证服务启动失败：\n${serverLog}`);
}

if (!externalBaseUrl) {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'relay-auth-'));
  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      RELAY_TEST_LISTEN_PORT: String(port),
      RELAY_ACCESS_TOKEN: accessToken,
      RELAY_DB_PATH: path.join(tempDir, 'relay.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
}

let authenticatedWs = null;
try {
  await waitForHealth();

  const anonymous = await request('/api/sessions');
  assert.equal(anonymous.status, 401);

  const wrongPassword = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong' }),
  });
  assert.equal(wrongPassword.status, 401);

  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(login.status, 200);
  const loginPayload = await login.json();
  assert.equal(loginPayload.user.username, 'admin');
  const setCookie = login.headers.get('set-cookie') || '';
  assert.match(setCookie, /relay_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Max-Age=2592000/);
  const sessionCookie = setCookie.match(/(?:^|,\s*)(relay_session=[^;]+)/u)?.[1];
  assert.ok(sessionCookie, '登录响应必须包含 relay_session Cookie');
  const cookie = sessionCookie;

  const me = await request('/api/auth/me', { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.username, 'admin');

  const sessions = await request('/api/sessions', { headers: { Cookie: cookie } });
  assert.equal(sessions.status, 200);

  await expectWebSocketRejected();
  authenticatedWs = await connectWebSocket(cookie);
  const websocketClosed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('退出后 WebSocket 未被主动关闭')), 3000);
    authenticatedWs.once('close', (code) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 1008);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });

  const logout = await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/);
  await websocketClosed;

  const afterLogout = await request('/api/sessions', { headers: { Cookie: cookie } });
  assert.equal(afterLogout.status, 401);

  console.log('认证验收通过：隔离服务、未登录保护、账号密码、30 天 Cookie、REST、WebSocket 与退出撤销均正常');
} finally {
  if (authenticatedWs && authenticatedWs.readyState !== WebSocket.CLOSED) authenticatedWs.terminate();
  if (child) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
}
