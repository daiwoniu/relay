import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { loginAndGetCookie } from './auth-client.mjs';

const port = 19084;
const baseUrl = `http://127.0.0.1:${port}`;
const wsUrl = `ws://127.0.0.1:${port}/ws`;
const token = `security-${Date.now()}`;
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'relay-security-'));
const dbPath = path.join(tempDir, 'relay.db');
const allowedFile = path.resolve(import.meta.dirname, '..', '..', 'workspace', `security-verify-${Date.now()}.txt`);

const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    RELAY_TEST_LISTEN_PORT: String(port),
    RELAY_ACCESS_TOKEN: token,
    RELAY_DB_PATH: dbPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
child.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
child.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`安全验证服务启动失败：\n${serverLog}`);
}

async function expectWebSocketRejected(headers = {}) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers });
    ws.once('open', () => reject(new Error('未携带令牌的 WebSocket 不应连接成功')));
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

try {
  await waitForHealth();

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);

  const unauthorized = await fetch(`${baseUrl}/api/projects`);
  assert.equal(unauthorized.status, 401);

  const internalHeaders = { 'X-Relay-Token': token };
  const internalOnly = await fetch(`${baseUrl}/api/projects`, { headers: internalHeaders });
  assert.equal(internalOnly.status, 401);
  const sessionCookie = await loginAndGetCookie(baseUrl, internalHeaders);
  const authorizedHeaders = { ...internalHeaders, Cookie: sessionCookie };
  const authorized = await fetch(`${baseUrl}/api/projects`, { headers: authorizedHeaders });
  assert.equal(authorized.status, 200);
  const projects = await authorized.json();
  const systemProject = projects.find((project) => project.is_system) || projects[0];

  const internalFieldUpdate = await fetch(`${baseUrl}/api/projects/${systemProject.id}`, {
    method: 'PATCH',
    headers: { ...authorizedHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_system: 0 }),
  });
  assert.equal(internalFieldUpdate.status, 400);

  const createdSessionResponse = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { ...authorizedHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: systemProject.id }),
  });
  assert.equal(createdSessionResponse.status, 201);
  const createdSession = await createdSessionResponse.json();

  const removedClientMessageWrite = await fetch(`${baseUrl}/api/sessions/${createdSession.id}/messages`, {
    method: 'POST',
    headers: { ...authorizedHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'client-message', role: 'assistant', content: '客户端不得写入回复' }),
  });
  assert.equal(removedClientMessageWrite.status, 404);
  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);

  const evilOrigin = await fetch(`${baseUrl}/api/projects`, {
    headers: { ...authorizedHeaders, Origin: 'https://evil.example.com' },
  });
  assert.equal(evilOrigin.headers.get('access-control-allow-origin'), null);

  const privateOrigin = 'http://192.168.10.20:9081';
  const allowedOrigin = await fetch(`${baseUrl}/api/projects`, {
    headers: { ...authorizedHeaders, Origin: privateOrigin },
  });
  assert.equal(allowedOrigin.headers.get('access-control-allow-origin'), privateOrigin);

  await writeFile(allowedFile, 'Relay security verification', 'utf8');
  const allowedRead = await fetch(`${baseUrl}/api/filesystem/read?path=${encodeURIComponent(allowedFile)}`, {
    headers: authorizedHeaders,
  });
  assert.equal(allowedRead.status, 200);

  const deniedRead = await fetch(`${baseUrl}/api/filesystem/read?path=${encodeURIComponent(process.execPath)}`, {
    headers: authorizedHeaders,
  });
  assert.equal(deniedRead.status, 403);

  await expectWebSocketRejected();
  await expectWebSocketRejected(internalHeaders);
  const authorizedWs = new WebSocket(wsUrl, { headers: authorizedHeaders });
  await new Promise((resolve, reject) => {
    authorizedWs.once('open', resolve);
    authorizedWs.once('error', reject);
  });
  authorizedWs.close();

  console.log(JSON.stringify({
    ok: true,
    restUnauthorizedStatus: unauthorized.status,
    loginUnauthorizedStatus: internalOnly.status,
    websocketUnauthorizedStatus: 401,
    evilOriginAllowed: false,
    privateOriginAllowed: true,
    projectFileStatus: allowedRead.status,
    outsideFileStatus: deniedRead.status,
    internalFieldUpdateStatus: internalFieldUpdate.status,
    removedClientMessageWriteStatus: removedClientMessageWrite.status,
  }, null, 2));

  await fetch(`${baseUrl}/api/sessions/${createdSession.id}`, {
    method: 'DELETE',
    headers: authorizedHeaders,
  });
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  await rm(tempDir, { recursive: true, force: true });
  await unlink(allowedFile).catch(() => undefined);
}
