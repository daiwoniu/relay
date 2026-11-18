import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { parseRelayConfig } from '../../scripts/lib/relay-config.mjs';
import { createFrontendGateway } from './frontend-gateway.js';
import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import { getHttpClientIp } from './http-client-ip.js';
import { resolveWebSocketClientIp } from './message-origin.js';
import { createChinaDayRouter } from './routes/china-day.js';
import { analyticsRequestContext,trustedGatewayFrontendContext } from './analytics/request-context.js';
import { isValidAccessToken } from './security.js';

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
    for(const hostedPath of ['/p/site/index.html','/p-preview/upload/capability/index.html']){
      const hosted=await request(gatewayPort,hostedPath);
      assert.equal(hosted.status,200);assert.equal(hosted.headers['x-backend-header'],'preserved');
      assert.equal(hosted.body.includes('Relay Index'),false,'hosting routes must reach the backend instead of the SPA');
    }
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

test('访问环境实际经过网关保留域名和内网IPv4/IPv6主机，去掉端口并忽略伪造转发主机',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-analytics-host-'));
  fs.writeFileSync(path.join(directory,'index.html'),'ok');
  const app=new Hono().get('/api/analytics-context',c=>c.json(analyticsRequestContext(c)));
  const backend=createAdaptorServer({fetch:app.fetch}) as http.Server,backendPort=await listen(backend);
  const gateway=createFrontendGateway({releaseDir:directory,buildId:'abcdef12',accessToken:'isolated-test-token',backendTarget:`http://127.0.0.1:${backendPort}`,relayConfig:parseRelayConfig(relayConfigText('relay.example:443,[fd00::1]:9081'))});
  try{
    const gatewayPort=await listen(gateway);
    for(const [host,expected] of [['192.168.1.23:9081','192.168.1.23'],['10.0.0.2:9081','10.0.0.2'],['172.16.0.2:9081','172.16.0.2'],['[fd00::1]:9081','fd00::1'],['relay.example:443','relay.example']]){
      const response=await request(gatewayPort,'/api/analytics-context',host,{headers:{'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1','X-Forwarded-Host':'forged.example'}});
      assert.equal(response.status,200,host);
      assert.deepEqual(JSON.parse(response.body),{accessHost:expected,environment:{device:'mobile',browser:'Safari',os:'iOS'}},host);
    }
  }finally{await close(gateway);await close(backend);fs.rmSync(directory,{recursive:true,force:true});}
});

test('网关前端版本固定来自release产物，覆盖外部伪造头；旧产物不采信伪造值',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'relay-frontend-version-'));
  fs.writeFileSync(path.join(directory,'index.html'),'ok');
  fs.writeFileSync(path.join(directory,'relay-version.json'),JSON.stringify({version:'0.40.0'}));
  const app=new Hono().get('/p/test',c=>c.json({version:trustedGatewayFrontendContext(c.req.header('x-relay-frontend-version'),isValidAccessToken(c.req.header('x-relay-token'),'version-test-token'),'127.0.0.1').clientVersion??null}));
  const backend=createAdaptorServer({fetch:app.fetch}) as http.Server,backendPort=await listen(backend);
  const options={releaseDir:directory,buildId:'abcdef12',accessToken:'version-test-token',backendTarget:`http://127.0.0.1:${backendPort}`,relayConfig:parseRelayConfig(relayConfigText())};
  const gateway=createFrontendGateway(options);
  let legacy:http.Server|undefined;
  try{
    const port=await listen(gateway);
    fs.writeFileSync(path.join(directory,'relay-version.json'),JSON.stringify({version:'0.41.0'}));
    assert.deepEqual(JSON.parse((await request(port,'/p/test','localhost:9081',{headers:{'X-Relay-Frontend-Version':'forged'}})).body),{version:'0.40.0'});
    fs.unlinkSync(path.join(directory,'relay-version.json'));
    legacy=createFrontendGateway(options);const legacyPort=await listen(legacy);
    assert.deepEqual(JSON.parse((await request(legacyPort,'/p/test','localhost:9081',{headers:{'X-Relay-Frontend-Version':'forged'}})).body),{version:null});
  }finally{if(legacy)await close(legacy);await close(gateway);await close(backend);fs.rmSync(directory,{recursive:true,force:true});}
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

test('IP诊断只在本机限时启用后向有效管理员返回白名单IP，不改变代理信任规则', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ip-diagnostic-'));
  fs.writeFileSync(path.join(directory, 'index.html'), 'Relay');
  const windowFile = path.join(directory, 'window.json');
  const enable = () => fs.writeFileSync(windowFile, JSON.stringify({ createdAt: Date.now(), expiresAt: Date.now() + 60_000 }));
  let authCalls = 0;
  let authMode = 'normal';
  const backend = http.createServer((req, res) => {
    authCalls++;
    assert.equal(req.url, '/api/auth/me');
    assert.equal(req.headers['x-relay-token'], 'internal-only');
    assert.equal(req.headers['x-forwarded-for'], undefined);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers['x-relay-client-address'], '127.0.0.1');
    if (authMode === 'down') { res.writeHead(503); res.end('private-error'); return; }
    if (authMode === 'oversize') { res.end('x'.repeat(65 * 1024)); return; }
    if (authMode === 'disable') fs.writeFileSync(windowFile, '{}');
    const cookie = req.headers.cookie;
    if (cookie === 'relay_session=invalid') { res.writeHead(401); res.end('{}'); return; }
    res.end(JSON.stringify({ user: {
      role: cookie === 'relay_session=member' ? 'member' : 'admin',
      mustChangePassword: cookie === 'relay_session=must-change',
      username: 'private-user', avatarUrl: 'private-avatar',
    } }));
  });
  const backendPort = await listen(backend);
  const gateway = createFrontendGateway({
    releaseDir: directory, buildId: 'abcdef12', accessToken: 'internal-only',
    backendTarget: `http://127.0.0.1:${backendPort}`, relayConfig: parseRelayConfig(relayConfigText('relay.example:443')),
    diagnosticWindowFile: windowFile,
  });
  const port = await listen(gateway);
  const probe = (headers: http.OutgoingHttpHeaders = {}, method = 'GET') => request(port, '/__relay/ip-diagnostic', 'relay.example:443', { method, headers });
  const admin = { cookie: 'relay_session=admin' };
  try {
    assert.equal((await probe(admin)).status, 404);
    for (const value of ['invalid json', '{}', JSON.stringify({ createdAt: Date.now() - 1000, expiresAt: Date.now() - 1 }),
      JSON.stringify({ createdAt: Date.now(), expiresAt: Date.now() + 25 * 3600_000 })]) {
      fs.writeFileSync(windowFile, value);
      assert.equal((await probe(admin)).status, 404);
    }
    assert.equal(authCalls, 0);
    enable();
    assert.equal((await probe(admin, 'POST')).status, 405);
    assert.equal((await probe()).status, 401);
    assert.equal((await probe({ ...admin, origin: 'null' })).status, 403);
    assert.equal((await probe({ ...admin, origin: 'https://evil.example' })).status, 403);
    assert.equal((await probe({ ...admin, 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal(authCalls, 0);
    assert.equal((await probe({ cookie: 'relay_session=invalid', 'x-user-role': 'admin' })).status, 401);
    assert.equal((await probe({ cookie: 'relay_session=member', 'x-user-role': 'admin' })).status, 403);
    assert.equal((await probe({ cookie: 'relay_session=must-change' })).status, 403);
    const result = await probe({ ...admin, origin: 'https://relay.example:443', authorization: 'private-auth',
      'x-forwarded-for': '203.0.113.9, invalid-private-value, 198.51.100.8',
      'x-real-ip': '::ffff:192.0.2.1', 'x-relay-client-address': '203.0.113.7', 'x-private-input': 'private-content' });
    assert.equal(result.status, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.socketPeer, '127.0.0.1');
    assert.equal(body.currentGatewayClientAddress, '127.0.0.1');
    assert.equal(body.currentGatewayForwardedFor, null);
    assert.equal(body.headerCandidatesTrusted, false);
    assert.deepEqual(body.observedHeaders['x-forwarded-for'], {
      omitted: false, ips: ['203.0.113.9', null, '198.51.100.8'], invalidCount: 1, lastIp: '198.51.100.8',
    });
    assert.equal(body.observedHeaders['x-real-ip'].lastIp, '192.0.2.1');
    assert.equal(body.observedHeaders['cf-connecting-ip'], null);
    assert.match(result.headers['cache-control']!, /no-store/);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
    assert.doesNotMatch(result.body, /private-|relay_session|internal-only|username|avatar/);
    const invalidTail = JSON.parse((await probe({ ...admin, 'x-forwarded-for': '203.0.113.9, bad' })).body);
    assert.equal(invalidTail.observedHeaders['x-forwarded-for'].lastIp, null, 'do not promote an earlier value when the last value is invalid');
    const oversized = JSON.parse((await probe({ ...admin, 'x-forwarded-for': '1'.repeat(4097) })).body);
    assert.equal(oversized.observedHeaders['x-forwarded-for'].omitted, true);
    const tooMany = JSON.parse((await probe({ ...admin, 'x-forwarded-for': Array(33).fill('203.0.113.1').join(',') })).body);
    assert.equal(tooMany.observedHeaders['x-forwarded-for'].omitted, true);
    for (authMode of ['down', 'oversize']) {
      const unavailable = await probe(admin);
      assert.equal(unavailable.status, 503);
      assert.doesNotMatch(unavailable.body, /private-|internal-only/);
    }
    authMode = 'disable';
    assert.equal((await probe(admin)).status, 404, 'disabling during identity verification must fail closed');
  } finally {
    await close(gateway); await close(backend);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('真实网关到Hono与WebSocket统一采用代理尾部来源，天气自动定位获得同一IP', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ip-forwarding-'));
  fs.writeFileSync(path.join(directory, 'index.html'), 'Relay');
  const app = new Hono();
  app.use('*', async (c, next) => c.req.header('x-relay-token') === 'synthetic-gateway' ? next() : c.text('Unauthorized', 401));
  app.get('/api/who', c => c.json({ ip: getHttpClientIp(c), forwarded: c.req.header('x-forwarded-for') ?? null,
    other: ['x-real-ip', 'cf-connecting-ip', 'forwarded'].map(name => c.req.header(name) ?? null) }));
  app.get('/api/auth/me', c => c.json({ user: { role: 'admin', mustChangePassword: false } }));
  app.route('/api/public/tools/china-day', createChinaDayRouter({ build: (async (input: { ip?: string }) => ({ ip: input.ip })) as any }));
  const backend = createAdaptorServer({ fetch: app.fetch }) as http.Server;
  const backendWs = new WebSocketServer({ server: backend });
  backendWs.on('connection', (socket, req) => {
    assert.equal(req.headers['x-relay-token'], 'synthetic-gateway');
    socket.send(JSON.stringify({ ip: resolveWebSocketClientIp({ remoteAddress: req.socket.remoteAddress,
      relayClientAddress: req.headers['x-relay-client-address'] }), forwarded: req.headers['x-forwarded-for'] }));
  });
  const backendPort = await listen(backend);
  const config = parseRelayConfig(relayConfigText('relay.example:443') + '\nTRUSTED_PROXY_IPS=127.0.0.1,::1');
  const windowFile = path.join(directory, 'window.json');
  fs.writeFileSync(windowFile, JSON.stringify({ createdAt: Date.now(), expiresAt: Date.now() + 60_000 }));
  const gateway = createFrontendGateway({ releaseDir: directory, buildId: 'abcdef12', accessToken: 'synthetic-gateway',
    backendTarget: `http://127.0.0.1:${backendPort}`, relayConfig: config, diagnosticWindowFile: windowFile });
  const gatewayPort = await listen(gateway);
  const headers = { 'x-forwarded-for': '198.51.100.1, 203.0.113.9', 'x-relay-client-address': '198.51.100.1',
    'x-real-ip': '198.51.100.1', 'cf-connecting-ip': '198.51.100.1', forwarded: 'for=198.51.100.1' };
  try {
    const result = JSON.parse((await request(gatewayPort, '/api/who', 'relay.example:443', { headers })).body);
    assert.deepEqual(result, { ip: '203.0.113.9', forwarded: '203.0.113.9', other: [null, null, null] });
    const diagnostic = JSON.parse((await request(gatewayPort, '/__relay/ip-diagnostic', 'relay.example:443', {
      headers: { ...headers, cookie: 'relay_session=synthetic-admin' },
    })).body);
    assert.equal(diagnostic.forwardedForAccepted, true);
    assert.equal(diagnostic.currentGatewayClientAddress, '203.0.113.9');
    assert.equal(diagnostic.currentGatewayForwardedFor, '203.0.113.9');
    for (const [xff, expected] of [
      [Array(17).fill('198.51.100.1').concat('203.0.113.9').join(','), '203.0.113.9'],
      ['198.51.100.1, ::FFFF:203.0.113.9', '203.0.113.9'],
      ['2001:0DB8:0:0:0:0:0:9', '2001:db8::9'],
    ]) {
      const observed = JSON.parse((await request(gatewayPort, '/__relay/ip-diagnostic', 'relay.example:443', {
        headers: { cookie: 'relay_session=synthetic-admin', 'x-forwarded-for': xff },
      })).body);
      assert.equal(observed.forwardedForAccepted, true);
      assert.equal(observed.observedHeaders['x-forwarded-for'].omitted, false);
      assert.equal(observed.observedHeaders['x-forwarded-for'].lastIp, expected);
      assert.equal(observed.currentGatewayClientAddress, expected);
    }
    const weather = JSON.parse((await request(gatewayPort, '/api/public/tools/china-day', 'relay.example:443', { headers })).body);
    assert.equal(weather.ip, '203.0.113.9');
    const local = JSON.parse((await request(gatewayPort, '/api/who', 'localhost:9081', { headers })).body);
    assert.equal(local.ip, '127.0.0.1'); assert.equal(local.forwarded, null);
    const malformed = JSON.parse((await request(gatewayPort, '/api/who', 'relay.example:443', {
      headers: { ...headers, 'x-forwarded-for': '203.0.113.9, invalid' },
    })).body);
    assert.equal(malformed.ip, '127.0.0.1'); assert.equal(malformed.forwarded, null);
    const ws = await new Promise<{ ip: string; forwarded: string }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws`, { headers: { Host: 'relay.example:443', ...headers } });
      socket.once('error', reject);
      socket.once('message', message => { socket.close(); resolve(JSON.parse(message.toString())); });
    });
    assert.deepEqual(ws, { ip: '203.0.113.9', forwarded: '203.0.113.9' });
  } finally {
    await close(gateway); backendWs.close(); await close(backend);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
