import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { parseRelayConfig } from '../../scripts/lib/relay-config.mjs';
import { createFrontendGateway } from './frontend-gateway.js';

const relayConfigText = (publicAddresses = '') => `CODEX_HOST=127.0.0.1
CODEX_PORT=9281
BACKEND_LISTEN_HOST=0.0.0.0
BACKEND_LISTEN_PORT=9181
FRONTEND_LISTEN_HOST=0.0.0.0
FRONTEND_LISTEN_PORT=9081
PUBLIC_ALLOWED_ADDRESSES=${publicAddresses}`;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request(
  port: number,
  pathname: string,
  host = 'localhost:9081',
  options: { method?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: options.method,
      headers: { Host: host, ...options.headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

test('正式前端网关限制 Host、代理令牌、静态缓存、分享页和状态接口', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-frontend-gateway-'));
  const releaseDir = path.join(directory, 'release');
  fs.mkdirSync(path.join(releaseDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(releaseDir, 'index.html'), '<!doctype html><div>Relay Index</div>');
  fs.writeFileSync(path.join(releaseDir, 'assets', 'app-abcdef12.js'), 'window.RELAY_TEST=true');
  let backendHeaders: http.IncomingHttpHeaders | null = null;
  let backendBody = '';
  let wsHeaders: http.IncomingHttpHeaders | null = null;
  const backend = http.createServer((req, res) => {
    backendHeaders = req.headers;
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      backendBody = Buffer.concat(chunks).toString('utf8');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Backend-Header', 'preserved');
      res.end(JSON.stringify({ ok: true, body: backendBody }));
    });
  });
  const backendWs = new WebSocketServer({ server: backend });
  backendWs.on('connection', (socket, request) => {
    wsHeaders = request.headers;
    socket.send('connected');
    socket.on('message', (message) => socket.send(`echo:${message.toString()}`));
  });
  const backendPort = await listen(backend);
  const gateway = createFrontendGateway({
    releaseDir,
    buildId: 'abcdef12',
    buildLabel: '20260809-1410 · abcdef1',
    accessToken: 'internal-secret-token',
    backendTarget: `http://127.0.0.1:${backendPort}`,
    relayConfig: parseRelayConfig(relayConfigText('relay.example:443')),
    startedAt: 123,
  });
  const gatewayPort = await listen(gateway);
  try {
    assert.equal((await request(gatewayPort, '/', 'evil.example')).status, 403);

    const api = await request(gatewayPort, '/api/health', 'relay.example:443', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-Relay-Token': 'forged-token',
        'X-Forwarded-Proto': 'http',
        'X-Forwarded-Host': 'evil.example',
        'X-Forwarded-For': '203.0.113.1',
      },
      body: 'streamed-body',
    });
    assert.equal(api.status, 200);
    assert.equal(api.body, '{"ok":true,"body":"streamed-body"}');
    assert.equal(api.headers['x-backend-header'], 'preserved');
    assert.equal(backendBody, 'streamed-body');
    assert.equal(api.body.includes('internal-secret-token'), false);
    assert.equal(backendHeaders?.['x-relay-token'], 'internal-secret-token');
    assert.equal(backendHeaders?.['x-forwarded-proto'], 'https');
    assert.equal(backendHeaders?.['x-forwarded-host'], 'relay.example:443');
    assert.equal(backendHeaders?.['x-forwarded-for'], undefined);
    assert.notEqual(backendHeaders?.['x-relay-client-address'], '203.0.113.1');

    const asset = await request(gatewayPort, '/assets/app-abcdef12.js');
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
    const index = await request(gatewayPort, '/nested/client/route');
    assert.equal(index.body.includes('Relay Index'), true);
    assert.equal(index.headers['cache-control'], 'no-store');

    const share = await request(gatewayPort, '/share/example');
    assert.equal(share.headers['x-robots-tag'], 'noindex, noarchive');
    assert.equal(share.headers['referrer-policy'], 'no-referrer');
    assert.equal(share.headers['cache-control'], 'no-store');

    const status = await request(gatewayPort, '/__relay/frontend-status');
    assert.deepEqual(JSON.parse(status.body), { startedAt: 123, mode: 'production', buildId: 'abcdef12', buildLabel: '20260809-1410 · abcdef1' });
    assert.equal(status.body.includes('internal-secret-token'), false);

    const wsMessages = await new Promise<string[]>((resolve, reject) => {
      const messages: string[] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws`, {
        headers: {
          Host: 'relay.example:443',
          'X-Relay-Token': 'forged-token',
          'X-Forwarded-Host': 'evil.example',
        },
      });
      socket.on('message', (message) => {
        messages.push(message.toString());
        if (messages.length === 1) socket.send('ping');
        if (messages.length === 2) { socket.close(); resolve(messages); }
      });
      socket.once('error', reject);
    });
    assert.deepEqual(wsMessages, ['connected', 'echo:ping']);
    assert.equal(wsHeaders?.['x-relay-token'], 'internal-secret-token');
    assert.equal(wsHeaders?.['x-forwarded-host'], 'relay.example:443');

    const traversal = await request(gatewayPort, '/%2e%2e/%2e%2e/package.json');
    assert.equal(traversal.body.includes('"name"'), false);
  } finally {
    await close(gateway);
    backendWs.close();
    await close(backend);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('正式前端网关在后端不可用时安全返回 502', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-frontend-gateway-backend-down-'));
  fs.writeFileSync(path.join(directory, 'index.html'), 'ok');
  const unavailable = http.createServer();
  const unavailablePort = await listen(unavailable);
  await close(unavailable);
  const gateway = createFrontendGateway({
    releaseDir: directory,
    buildId: 'abcdef12',
    accessToken: 'internal-secret-token',
    backendTarget: `http://127.0.0.1:${unavailablePort}`,
    relayConfig: parseRelayConfig(relayConfigText()),
  });
  const gatewayPort = await listen(gateway);
  try {
    const response = await request(gatewayPort, '/api/health');
    assert.equal(response.status, 502);
    assert.equal(response.body, 'Relay 后端暂不可用');
    assert.doesNotMatch(response.body, /ECONNREFUSED|127\.0\.0\.1|internal-secret-token/);
  } finally {
    await close(gateway);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('正式网关拒绝无效 buildId、release 和令牌', () => {
  const config = parseRelayConfig(relayConfigText());
  assert.throws(() => createFrontendGateway({ releaseDir: 'missing', buildId: 'abcdef12', accessToken: 'token', relayConfig: config }), /release 不存在/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-frontend-gateway-invalid-'));
  try {
    fs.writeFileSync(path.join(directory, 'index.html'), 'ok');
    assert.throws(() => createFrontendGateway({ releaseDir: directory, buildId: '../bad', accessToken: 'token', relayConfig: config }), /buildId 无效/);
    assert.throws(() => createFrontendGateway({ releaseDir: directory, buildId: 'abcdef12', accessToken: '', relayConfig: config }), /缺少内部访问令牌/);
    assert.throws(() => createFrontendGateway({
      releaseDir: directory,
      buildId: 'abcdef12',
      accessToken: 'token',
      backendTarget: 'file:///etc/passwd',
      relayConfig: config,
    }), /只支持 http 或 https/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
