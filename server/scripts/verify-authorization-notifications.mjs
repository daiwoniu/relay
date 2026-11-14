import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';

const relayPort = Number(process.env.RELAY_VERIFY_PORT || 9182);
const codexPort = Number(process.env.RELAY_VERIFY_CODEX_PORT || 9281);
const baseUrl = `http://127.0.0.1:${relayPort}`;
const wsUrl = `ws://127.0.0.1:${relayPort}/ws`;
const accessToken = process.env.RELAY_ACCESS_TOKEN || 'relay-authorization-notification-verification';
const serverRoot = path.resolve(import.meta.dirname, '..');
const relayRoot = path.resolve(serverRoot, '..');
const testRoot = path.join(relayRoot, '.relay-test');
const dbPath = path.join(testRoot, 'authorization-notifications.db');
const workspacePath = path.join(testRoot, 'authorization-workspace');
const accessHeaders = { 'X-Relay-Token': accessToken };
const childOutput = [];
let relayChild = null;

mkdirSync(workspacePath, { recursive: true });
rmSync(dbPath, { force: true });

function createInbox(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else queue.push(message);
  });
  return {
    wait(predicate, timeoutMs = 15_000) {
      const existing = queue.findIndex(predicate);
      if (existing >= 0) return Promise.resolve(queue.splice(existing, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('等待授权提醒验收事件超时'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    async expectNone(predicate, durationMs = 350) {
      const existing = queue.find(predicate);
      if (existing) throw new Error(`收到不应出现的事件：${JSON.stringify(existing)}`);
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      const later = queue.find(predicate);
      if (later) throw new Error(`收到不应出现的事件：${JSON.stringify(later)}`);
    },
  };
}

async function waitForRelay() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`, { headers: accessHeaders });
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`隔离 Relay 服务未在 ${relayPort} 端口就绪\n${childOutput.slice(-20).join('')}`);
}

function startMockCodex() {
  let connectionSequence = 0;
  const approvals = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: codexPort });
  wss.on('connection', (socket) => {
    const connectionId = ++connectionSequence;
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ id: message.id, result: { serverInfo: { name: 'mock-codex', model: 'mock' }, platformOs: 'windows' } }));
        return;
      }
      if (message.method === 'config/read') {
        socket.send(JSON.stringify({ id: message.id, result: { model: 'mock', modelProvider: 'local' } }));
        return;
      }
      if (message.method === 'thread/start' || message.method === 'thread/resume') {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: message.params?.threadId || `mock-thread-${connectionId}`, model: 'mock' } } }));
        return;
      }
      if (message.method === 'turn/start') {
        const turnId = `mock-turn-${connectionId}-${Date.now()}`;
        socket.send(JSON.stringify({ id: message.id, result: { turn: { id: turnId } } }));
        socket.send(JSON.stringify({ method: 'turn/started', params: { turn: { id: turnId } } }));
        const text = message.params?.input?.[0]?.text || '';
        const requestId = 'shared-request';
        const method = text.includes('PERMISSION_APPROVAL') ? 'item/permissions/requestApproval' : 'item/commandExecution/requestApproval';
        const params = method.includes('permissions')
          ? { reason: '需要访问隔离验证资源', permissions: { network: true }, availableDecisions: ['accept', 'decline'] }
          : { command: 'echo isolated-approval', cwd: workspacePath, reason: '隔离命令验证', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] };
        approvals.push({ socket, connectionId, requestId, method, result: undefined });
        setTimeout(() => socket.send(JSON.stringify({ id: requestId, method, params })), 20);
        return;
      }
      if (message.id !== undefined && !message.method) {
        const approval = approvals.find((item) => item.socket === socket && item.requestId === String(message.id));
        if (approval) approval.result = message.result;
      }
    });
  });
  return { wss, approvals };
}

function startRelay() {
  relayChild = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      CODEX_WS_URL: `ws://127.0.0.1:${codexPort}`,
      RELAY_TEST_LISTEN_PORT: String(relayPort),
      RELAY_DB_PATH: dbPath,
      RELAY_ACCESS_TOKEN: accessToken,
      ALLOWED_ORIGINS: `http://127.0.0.1:9183,http://localhost:9183`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  relayChild.stdout.on('data', (chunk) => childOutput.push(chunk.toString()));
  relayChild.stderr.on('data', (chunk) => childOutput.push(chunk.toString()));
}

async function requestJson(cookie, requestPath, options = {}) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    ...options,
    headers: { ...accessHeaders, Cookie: cookie, ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${requestPath} 失败：${response.status} ${await response.text()}`);
  return response.json();
}

async function loginForVerification() {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { ...accessHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  if (!response.ok) throw new Error(`认证登录失败：${response.status} ${await response.text()}`);
  const rawCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : (response.headers.get('set-cookie') || '').split(/,(?=\s*[^;,]+=)/);
  const cookies = rawCookies.map((value) => value.split(';', 1)[0]).filter(Boolean);
  if (!cookies.some((value) => value.startsWith('relay_session='))) throw new Error(`认证登录没有返回会话 Cookie：${rawCookies.join(' | ')}`);
  return cookies.join('; ');
}

async function openClient(cookie) {
  const ws = new WebSocket(wsUrl, { headers: { ...accessHeaders, Cookie: cookie, Origin: 'http://127.0.0.1:9183' } });
  const inbox = createInbox(ws);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const protocol = await inbox.wait((message) => message.type === 'protocol_info');
  assert.equal(protocol.protocolVersion, 10);
  const snapshot = await inbox.wait((message) => message.type === 'pending_approvals_snapshot');
  return { ws, inbox, snapshot };
}

const mock = startMockCodex();
startRelay();
const clients = [];
const sessions = [];
let project = null;

try {
  await waitForRelay();
  const cookie = await loginForVerification();
  project = await requestJson(cookie, '/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: workspacePath, name: '授权提醒隔离验收' }),
  });
  for (const title of ['授权提醒会话一', '授权提醒会话二']) {
    sessions.push(await requestJson(cookie, '/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, projectId: project.id }),
    }));
  }

  const clientA = await openClient(cookie);
  const clientB = await openClient(cookie);
  clients.push(clientA, clientB);
  assert.deepEqual(clientA.snapshot.approvals, []);
  assert.deepEqual(clientB.snapshot.approvals, []);
  clientA.ws.send(JSON.stringify({ type: 'subscribe', sessionId: sessions[0].id }));
  clientB.ws.send(JSON.stringify({ type: 'subscribe', sessionId: sessions[1].id }));
  await Promise.all([
    clientA.inbox.wait((message) => message.type === 'sync_state' && message.sessionId === sessions[0].id),
    clientB.inbox.wait((message) => message.type === 'sync_state' && message.sessionId === sessions[1].id),
  ]);

  clientA.ws.send(JSON.stringify({ type: 'send', sessionId: sessions[0].id, messageId: randomUUID(), content: 'COMMAND_APPROVAL' }));
  const commandA = await clientA.inbox.wait((message) => message.type === 'pending_approval_upserted' && message.approval.sessionId === sessions[0].id);
  const commandB = await clientB.inbox.wait((message) => message.type === 'pending_approval_upserted' && message.approval.id === commandA.approval.id);
  assert.equal(commandB.approval.kind, 'command_approval');

  clientB.ws.send(JSON.stringify({ type: 'send', sessionId: sessions[1].id, messageId: randomUUID(), content: 'PERMISSION_APPROVAL' }));
  const permissionA = await clientA.inbox.wait((message) => message.type === 'pending_approval_upserted' && message.approval.sessionId === sessions[1].id);
  const permissionB = await clientB.inbox.wait((message) => message.type === 'pending_approval_upserted' && message.approval.id === permissionA.approval.id);
  assert.equal(permissionB.approval.kind, 'permissions_approval');

  const clientC = await openClient(cookie);
  clients.push(clientC);
  assert.deepEqual(
    new Set(clientC.snapshot.approvals.map((item) => `${item.sessionId}::${item.id}`)),
    new Set([`${commandA.approval.sessionId}::${commandA.approval.id}`, `${permissionA.approval.sessionId}::${permissionA.approval.id}`]),
  );
  await clientC.inbox.expectNone((message) => message.type === 'pending_approval_upserted');

  const acceptOperationId = randomUUID();
  clientA.ws.send(JSON.stringify({ type: 'respond_interaction', operationId: acceptOperationId, sessionId: sessions[0].id, interactionId: commandA.approval.id, action: 'accept' }));
  const accepted = await clientA.inbox.wait((message) => message.type === 'interaction_response_result' && message.operationId === acceptOperationId);
  assert.equal(accepted.outcome, 'accepted');
  await Promise.all([
    clientA.inbox.wait((message) => message.type === 'pending_approval_resolved' && message.sessionId === sessions[0].id && message.interactionId === commandA.approval.id),
    clientB.inbox.wait((message) => message.type === 'pending_approval_resolved' && message.sessionId === sessions[0].id && message.interactionId === commandA.approval.id),
  ]);
  assert.deepEqual(mock.approvals.find((item) => item.method === 'item/commandExecution/requestApproval')?.result, { decision: 'accept' });

  const clientD = await openClient(cookie);
  clients.push(clientD);
  assert.deepEqual(clientD.snapshot.approvals.map((item) => `${item.sessionId}::${item.id}`), [`${permissionA.approval.sessionId}::${permissionA.approval.id}`]);

  const duplicateOperationId = randomUUID();
  clientB.ws.send(JSON.stringify({ type: 'respond_interaction', operationId: duplicateOperationId, sessionId: sessions[0].id, interactionId: commandA.approval.id, action: 'accept' }));
  const skipped = await clientB.inbox.wait((message) => message.type === 'interaction_response_result' && message.operationId === duplicateOperationId);
  assert.equal(skipped.outcome, 'skipped');

  const preferenceEventA = clientA.inbox.wait((message) => message.type === 'notification_preferences_updated');
  const preferenceEventB = clientB.inbox.wait((message) => message.type === 'notification_preferences_updated');
  const preferenceResponse = await requestJson(cookie, '/api/auth/notification-preferences', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ desktopSystemEnabled: true, mobileSoundEnabled: true }),
  });
  assert.equal(preferenceResponse.preferences.desktopSystemEnabled, true);
  const [updatedA, updatedB] = await Promise.all([preferenceEventA, preferenceEventB]);
  assert.deepEqual(updatedA.preferences, preferenceResponse.preferences);
  assert.deepEqual(updatedB.preferences, preferenceResponse.preferences);

  console.log(JSON.stringify({
    ok: true,
    ports: { codex: codexPort, relay: relayPort, vite: 9183 },
    sessions: sessions.map((session) => session.id),
    approvals: [commandA.approval.id, permissionA.approval.id],
    authenticatedClientsReceivedGlobalUpserts: 2,
    snapshotOnlyOnNewConnection: true,
    resolvedBroadcastToOtherClient: true,
    duplicateOutcome: skipped.outcome,
    notificationPreferencesSyncedClients: 2,
  }, null, 2));
} finally {
  for (const client of clients) client.ws.close();
  if (sessions.length > 0) {
    try {
      const cookie = await loginForVerification();
      for (const session of sessions) await requestJson(cookie, `/api/sessions/${session.id}`, { method: 'DELETE' }).catch(() => undefined);
      if (project) await requestJson(cookie, `/api/projects/${project.id}`, { method: 'DELETE' }).catch(() => undefined);
    } catch {}
  }
  await new Promise((resolve) => mock.wss.close(resolve));
  if (relayChild && !relayChild.killed) {
    relayChild.kill('SIGTERM');
    await new Promise((resolve) => { relayChild.once('exit', resolve); setTimeout(resolve, 2_000); });
  }
  rmSync(dbPath, { force: true });
  rmSync(workspacePath, { recursive: true, force: true });
}
