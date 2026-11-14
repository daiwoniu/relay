import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

type JsonValue = Record<string, any>;

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(serverRoot, '..');

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export function assertIsolatedVerificationPaths(input: {
  tempRoot: string;
  dbPath: string;
  workspacePath: string;
  projectRoot?: string;
}): void {
  const root = path.resolve(input.tempRoot);
  const project = path.resolve(input.projectRoot ?? projectRoot);
  for (const candidate of [input.dbPath, input.workspacePath]) {
    const resolved = path.resolve(candidate);
    assert.notEqual(resolved, project, '隔离验收路径不得等于正式项目根目录');
    assert.equal(resolved.startsWith(`${root}${path.sep}`), true, `隔离验收路径必须位于临时根目录：${resolved}`);
  }
}

function createInbox(ws: WebSocket) {
  const queue: JsonValue[] = [];
  const waiters: Array<{ predicate: (value: JsonValue) => boolean; resolve: (value: JsonValue) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  ws.on('message', (raw) => {
    const value = JSON.parse(raw.toString());
    const index = waiters.findIndex((waiter) => waiter.predicate(value));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    } else queue.push(value);
  });
  return {
    wait(predicate: (value: JsonValue) => boolean, timeoutMs = 15_000): Promise<JsonValue> {
      const existing = queue.findIndex(predicate);
      if (existing >= 0) return Promise.resolve(queue.splice(existing, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error('等待隔离多引擎事件超时'));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

function startMockCodex() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const threads = new Map<string, string>();
  let turnSequence = 0;
  wss.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialized') return;
    if (message.method === 'initialize' || message.method === 'config/read') {
      socket.send(JSON.stringify({ id: message.id, result: message.method === 'initialize' ? { serverInfo: { name: 'mock-codex' }, platformOs: 'windows' } : { model: 'mock-codex', modelProvider: 'isolated' } }));
      return;
    }
    if (message.method === 'thread/list') {
      socket.send(JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } }));
      return;
    }
    if (message.method === 'model/list') {
      socket.send(JSON.stringify({ id: message.id, result: { data: [
        { id: 'mock-codex', displayName: 'Mock Codex', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }] },
        { id: 'mock-codex-fast', displayName: 'Mock Codex Fast', isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }] },
      ], nextCursor: null } }));
      return;
    }
    if (message.method === 'thread/read') {
      const threadId = String(message.params?.threadId || 'thread-missing');
      socket.send(JSON.stringify({ id: message.id, result: { thread: { id: threadId, status: { type: 'idle', activeFlags: [] }, turns: [] } } }));
      return;
    }
    if (['thread/archive', 'thread/unarchive'].includes(message.method)) {
      socket.send(JSON.stringify({ id: message.id, result: {} }));
      return;
    }
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      const threadId = String(message.params?.threadId || `codex-thread-${randomUUID()}`);
      threads.set(threadId, threadId);
      socket.send(JSON.stringify({ id: message.id, result: { thread: { id: threadId, model: 'mock-codex' } } }));
      return;
    }
    if (message.method === 'turn/interrupt') {
      socket.send(JSON.stringify({ id: message.id, result: {} }));
      return;
    }
    if (message.method !== 'turn/start') return;
    const turnId = `codex-turn-${++turnSequence}`;
    const threadId = String(message.params?.threadId || [...threads.keys()].at(-1) || 'codex-thread');
    const text = String(message.params?.input?.[0]?.text || '');
    socket.send(JSON.stringify({ id: message.id, result: { turn: { id: turnId } } }));
    socket.send(JSON.stringify({ method: 'turn/started', params: { threadId, turn: { id: turnId } } }));
    const answer = `Codex:${text}`;
    setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 4, reasoningOutputTokens: 1, totalTokens: 16 }, modelContextWindow: 128000 } } }));
      socket.send(JSON.stringify({ method: 'item/started', params: { threadId, turnId, item: { id: `${turnId}-answer`, type: 'agentMessage', phase: 'final_answer', text: '' } } }));
      socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: `${turnId}-answer`, phase: 'final_answer', delta: answer } }));
      socket.send(JSON.stringify({ method: 'item/completed', params: { threadId, turnId, item: { id: `${turnId}-answer`, type: 'agentMessage', phase: 'final_answer', text: answer } } }));
      socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } }));
    }, 40);
  }));
  return wss;
}

const fakeCodeBuddySource = String.raw`
const readline = require('node:readline');
const crypto = require('node:crypto');
const rl = readline.createInterface({ input: process.stdin });
let sessionId = null;
let pendingPrompt = null;
let currentModel = 'mock';
let thoughtLevel = 'enabled';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const finish = (id, text) => {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'CodeBuddy 处理中' } } } });
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-' + id, title: 'Bash', status: 'in_progress', rawInput: { command: 'Write-Output isolated' } } } });
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-' + id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] } } });
  send({ jsonrpc: '2.0', method: 'codebuddy.ai/memberEvent', params: { memberId: 'member-' + id, name: '隔离成员', status: 'completed', summary: '子任务完成' } });
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'usage_update', used: 20, size: 192000, _meta: { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_cache_hit_tokens: 3 } } } } });
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'answer-' + id, content: { type: 'text', text } } } });
  send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', _meta: { 'codebuddy.ai/outcome': 'SUCCESS' } } });
};
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  if (message.method === 'session/new') {
    sessionId = 'codebuddy-session-' + crypto.createHash('sha1').update(process.cwd()).digest('hex').slice(0, 10);
    return send({ jsonrpc: '2.0', id: message.id, result: { sessionId, models: { currentModelId: currentModel, availableModels: [{ modelId: 'mock', name: 'Mock CodeBuddy' }, { modelId: 'mock-fast', name: 'Mock CodeBuddy Fast' }] }, configOptions: [{ id: 'thought_level', category: 'thought_level', currentValue: thoughtLevel, options: [{ value: 'enabled', name: 'On' }, { value: 'low', name: 'Low' }] }] } });
  }
  if (message.method === 'session/load') {
    sessionId = message.params.sessionId;
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAY_SHOULD_NOT_APPEAR' }, _meta: { 'codebuddy.ai.mode': 'history' } } } });
    return send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
  }
  if (message.method === 'session/cancel') {
    if (pendingPrompt) { send({ jsonrpc: '2.0', id: pendingPrompt, result: { stopReason: 'cancelled', _meta: { 'codebuddy.ai/outcome': 'CANCELLED' } } }); pendingPrompt = null; }
    return;
  }
  if (message.method === 'session/set_model') { currentModel = message.params.modelId; return send({ jsonrpc: '2.0', id: message.id, result: { modelId: currentModel } }); }
  if (message.method === 'session/set_config_option') { thoughtLevel = message.params.value; return send({ jsonrpc: '2.0', id: message.id, result: {} }); }
  if (message.method === 'session/prompt') {
    const text = String(message.params.prompt?.[0]?.text || '');
    if (text.includes('HANG')) { pendingPrompt = message.id; return; }
    if (text.includes('FAIL')) return send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn', _meta: { 'codebuddy.ai/businessFailed': true, 'codebuddy.ai/outcome': 'FAILED' } } });
    if (text.includes('EMPTY')) return send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn', _meta: { 'codebuddy.ai/outcome': 'SUCCESS' } } });
    if (text.includes('PERMISSION')) {
      pendingPrompt = message.id;
      return send({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: { sessionId, options: [{ kind: 'allow_always', name: 'Always Allow', optionId: 'always' }, { kind: 'allow_once', name: 'Allow', optionId: 'once' }, { kind: 'reject_once', name: 'Reject', optionId: 'reject' }], toolCall: { toolCallId: 'permission-tool', rawInput: { command: 'Write-Output permission', description: '隔离权限验证' }, _meta: { 'codebuddy.ai/toolName': 'Bash' } } } });
    }
    return setTimeout(() => finish(message.id, 'CodeBuddy:' + text), 45);
  }
  if (message.id === 77 && message.result) {
    const id = pendingPrompt; pendingPrompt = null;
    return finish(id, 'CodeBuddy:PERMISSION_ACCEPTED');
  }
});
`;

async function createFakeCodeBuddy(tempRoot: string) {
  const binRoot = path.join(tempRoot, 'fake-bin');
  const entrypoint = path.join(binRoot, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');
  await mkdir(path.dirname(entrypoint), { recursive: true });
  await writeFile(entrypoint, fakeCodeBuddySource, 'utf8');
  return { binRoot, entrypoint, offlineEntrypoint: `${entrypoint}.offline` };
}

async function waitForRelay(baseUrl: string, token: string, output: string[]): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`, { headers: { 'X-Relay-Token': token } });
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`隔离 Relay 未就绪：\n${output.slice(-30).join('')}`);
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

async function login(baseUrl: string, token: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'X-Relay-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  assert.equal(response.ok, true, `隔离登录失败：${response.status} ${await response.text()}`);
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  return values.map((value) => value.split(';', 1)[0]).filter(Boolean).join('; ');
}

export async function runMultiEngineVerification(): Promise<JsonValue> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'relay-multi-engine-'));
  const dbPath = path.join(tempRoot, 'data', 'relay.db');
  const workspacePath = path.join(tempRoot, 'workspace');
  assertIsolatedVerificationPaths({ tempRoot, dbPath, workspacePath });
  await mkdir(workspacePath, { recursive: true });
  const fake = await createFakeCodeBuddy(tempRoot);
  const codex = startMockCodex();
  await new Promise<void>((resolve) => codex.once('listening', () => resolve()));
  const codexAddress = codex.address();
  assert(codexAddress && typeof codexAddress === 'object');
  const relayPort = await reservePort();
  assert.equal([9081, 9181, 9281].includes(relayPort), false);
  const baseUrl = `http://127.0.0.1:${relayPort}`;
  const wsUrl = `ws://127.0.0.1:${relayPort}/ws`;
  const token = `relay-multi-engine-${randomUUID()}`;
  const output: string[] = [];
  let relay: ChildProcess | null = null;
  let stage = '初始化';
  const sockets: WebSocket[] = [];

  await mkdir(path.join(tempRoot, '.relay-setup'), { recursive: true });
  await writeFile(path.join(tempRoot, '.relay-setup', 'setup-state.json'), JSON.stringify({
    engines: {
      codex: { cliInstalled: true, protocolReady: true, available: true, version: 'mock-codex' },
      codebuddy: {
        cliInstalled: true,
        acpSupported: true,
        authReady: true,
        protocolReady: true,
        available: true,
        readinessCheckedAt: new Date().toISOString(),
        version: 'mock-codebuddy',
      },
    },
  }), 'utf8');

  const startRelay = async () => {
    relay = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: serverRoot,
      env: {
        ...process.env,
        RELAY_TEST_LISTEN_PORT: String(relayPort),
        CODEX_WS_URL: `ws://127.0.0.1:${codexAddress.port}`,
        RELAY_DB_PATH: dbPath,
        RELAY_ROOT: tempRoot,
        RELAY_ACCESS_TOKEN: token,
        ALLOWED_ORIGINS: `http://127.0.0.1:${relayPort}`,
        PATH: [fake.binRoot, process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : ''].filter(Boolean).join(path.delimiter),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    relay.stdout?.on('data', (chunk) => output.push(chunk.toString()));
    relay.stderr?.on('data', (chunk) => output.push(chunk.toString()));
    await waitForRelay(baseUrl, token, output);
  };

  try {
    stage = '启动隔离 Relay';
    await startRelay();
    let cookie = await login(baseUrl, token);
    const headers = () => ({ 'X-Relay-Token': token, Cookie: cookie, 'Content-Type': 'application/json' });
    const request = async (pathname: string, options: RequestInit = {}) => {
      const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`${options.method || 'GET'} ${pathname} 失败：${response.status} ${JSON.stringify(body)}`);
      return body;
    };
    const openClient = async () => {
      const ws = new WebSocket(wsUrl, { headers: { 'X-Relay-Token': token, Cookie: cookie, Origin: `http://127.0.0.1:${relayPort}` } });
      const inbox = createInbox(ws);
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
      await inbox.wait((event) => event.type === 'protocol_info');
      await inbox.wait((event) => event.type === 'pending_approvals_snapshot');
      return { ws, inbox };
    };

    stage = '创建双引擎会话';
    const projects = await request('/api/projects');
    assert.equal(projects.length, 1);
    assert.equal(path.resolve(projects[0].path), path.resolve(workspacePath));
    const project = projects[0];
    const codexSession = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ title: 'Codex 隔离会话', projectId: project.id, engine: 'codex' }) });
    const codeBuddySession = await request('/api/sessions', { method: 'POST', body: JSON.stringify({ title: 'CodeBuddy 隔离会话', projectId: project.id, engine: 'codebuddy' }) });
    assert.equal(codexSession.project_id, codeBuddySession.project_id);
    assert.notEqual(codexSession.id, codeBuddySession.id);

    stage = '连接双客户端';
    const codexClient = await openClient();
    const codeBuddyClient = await openClient();
    codexClient.ws.send(JSON.stringify({ type: 'subscribe', sessionId: codexSession.id }));
    codeBuddyClient.ws.send(JSON.stringify({ type: 'subscribe', sessionId: codeBuddySession.id }));
    await Promise.all([
      codexClient.inbox.wait((event) => event.type === 'sync_state' && event.sessionId === codexSession.id),
      codeBuddyClient.inbox.wait((event) => event.type === 'sync_state' && event.sessionId === codeBuddySession.id),
    ]);

    stage = '并发完成双引擎消息';
    codexClient.ws.send(JSON.stringify({ type: 'send', sessionId: codexSession.id, messageId: randomUUID(), content: 'CONCURRENT_CODEX' }));
    codeBuddyClient.ws.send(JSON.stringify({ type: 'send', sessionId: codeBuddySession.id, messageId: randomUUID(), content: 'CONCURRENT_CODEBUDDY' }));
    const [codexComplete, codeBuddyComplete] = await Promise.all([
      codexClient.inbox.wait((event) => event.type === 'message_complete' && event.sessionId === codexSession.id),
      codeBuddyClient.inbox.wait((event) => event.type === 'message_complete' && event.sessionId === codeBuddySession.id),
    ]);
    assert.match(codexComplete.content, /Codex:CONCURRENT_CODEX/);
    assert.match(codeBuddyComplete.content, /CodeBuddy:CONCURRENT_CODEBUDDY/);

    stage = '同一会话切换模型并保存逐轮快照';
    const verifyTwoModels = async (client: Awaited<ReturnType<typeof openClient>>, session: any, first: any, second: any, prefix: string) => {
      let revision = session.engine_preferences.revision;
      const snapshots: unknown[] = [];
      for (const [index, preferences] of [first, second].entries()) {
        const updated = await request(`/api/sessions/${session.id}/engine-preferences`, { method: 'PATCH', body: JSON.stringify({ ...preferences, expectedRevision: revision }) });
        revision = updated.session.engine_preferences.revision;
        const content = `${prefix}_MODEL_${index + 1}`;
        client.ws.send(JSON.stringify({ type: 'send', sessionId: session.id, messageId: randomUUID(), content }));
        await client.inbox.wait((event) => event.type === 'message_complete' && event.sessionId === session.id && event.content.includes(content));
        const saved = await client.inbox.wait((event) => event.type === 'message_saved' && event.sessionId === session.id && event.message?.role === 'assistant' && event.message.content.includes(content));
        snapshots.push(saved.message.modelInfo?.effective?.id);
      }
      const page = await request(`/api/sessions/${session.id}/messages?limit=100`);
      const messages = Array.isArray(page) ? page : page.messages;
      const persisted = messages.filter((message: any) => message.role === 'assistant' && message.content.includes(`${prefix}_MODEL_`)).map((message: any) => message.modelInfo?.effective?.id);
      assert.deepEqual(snapshots, [first.modelId, second.modelId]);
      assert.deepEqual(persisted.slice(-2), snapshots);
      return snapshots;
    };
    await verifyTwoModels(codexClient, codexSession,
      { modelId: 'mock-codex-fast', reasoningEffort: 'low' },
      { modelId: 'mock-codex', reasoningEffort: 'medium' }, 'CODEX');
    await verifyTwoModels(codeBuddyClient, codeBuddySession,
      { modelId: 'mock-fast', reasoningEffort: 'low' },
      { modelId: 'mock', reasoningEffort: 'enabled' }, 'CODEBUDDY');
    const codeBuddyAfterModels = await request(`/api/sessions/${codeBuddySession.id}`);
    await request(`/api/sessions/${codeBuddySession.id}/engine-preferences`, { method: 'PATCH', body: JSON.stringify({ modelId: null, reasoningEffort: null, expectedRevision: codeBuddyAfterModels.engine_preferences.revision }) });

    stage = 'CodeBuddy 权限交互';
    codeBuddyClient.ws.send(JSON.stringify({ type: 'send', sessionId: codeBuddySession.id, messageId: randomUUID(), content: 'PERMISSION' }));
    const approval = await codeBuddyClient.inbox.wait((event) => event.type === 'pending_approval_upserted' && event.approval.sessionId === codeBuddySession.id);
    assert.equal(approval.approval.engine, 'codebuddy');
    const operationId = randomUUID();
    codeBuddyClient.ws.send(JSON.stringify({ type: 'respond_interaction', operationId, sessionId: codeBuddySession.id, interactionId: approval.approval.id, action: 'accept' }));
    await codeBuddyClient.inbox.wait((event) => event.type === 'interaction_response_result' && event.operationId === operationId && event.outcome === 'accepted');
    await codeBuddyClient.inbox.wait((event) => event.type === 'message_complete' && event.content === 'CodeBuddy:PERMISSION_ACCEPTED');

    stage = 'CodeBuddy 失败分类';
    for (const scenario of [
      ['FAIL', 'CODEBUDDY_PROVIDER_ERROR'],
      ['EMPTY', 'CODEBUDDY_FINAL_ANSWER_MISSING'],
    ] as const) {
      stage = `CodeBuddy 失败分类 ${scenario[0]}`;
      codeBuddyClient.ws.send(JSON.stringify({ type: 'send', sessionId: codeBuddySession.id, messageId: randomUUID(), content: scenario[0] }));
      await codeBuddyClient.inbox.wait((event) => event.type === 'error' && event.sessionId === codeBuddySession.id && event.code === scenario[1]);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    stage = 'CodeBuddy 取消';
    codeBuddyClient.ws.send(JSON.stringify({ type: 'send', sessionId: codeBuddySession.id, messageId: randomUUID(), content: 'HANG_CANCEL' }));
    await codeBuddyClient.inbox.wait((event) => event.type === 'turn_start' && event.sessionId === codeBuddySession.id);
    codeBuddyClient.ws.send(JSON.stringify({ type: 'cancel', sessionId: codeBuddySession.id }));
    await codeBuddyClient.inbox.wait((event) => event.type === 'turn_cancelled' && event.sessionId === codeBuddySession.id);

    stage = '创建 CodeBuddy 分享';
    const share = await request('/api/shares', { method: 'POST', body: JSON.stringify({ sessionId: codeBuddySession.id, title: 'CodeBuddy 离线分享', scope: 'session', includeProcess: true, expiry: { type: 'permanent' } }) });
    const publicBefore = await request(`/api/public/shares/${share.publicToken}`);
    assert.equal(publicBefore.snapshot.sourceEngine, 'codebuddy');

    stage = 'CodeBuddy 重启中断';
    codeBuddyClient.ws.send(JSON.stringify({ type: 'send', sessionId: codeBuddySession.id, messageId: randomUUID(), content: 'HANG_RESTART' }));
    await codeBuddyClient.inbox.wait((event) => event.type === 'request_forwarded' && event.sessionId === codeBuddySession.id);
    await codeBuddyClient.inbox.wait((event) => event.type === 'turn_start' && event.sessionId === codeBuddySession.id);
    const processingBeforeRestart = await request(`/api/sessions/${codeBuddySession.id}`);
    assert.equal(processingBeforeRestart.status, 'processing');
    for (const socket of sockets.splice(0)) socket.close();
    await stopChild(relay);
    await startRelay();
    cookie = await login(baseUrl, token);
    const interrupted = await request(`/api/sessions/${codeBuddySession.id}`);
    assert.equal(interrupted.status, 'interrupted');
    const messagesAfterRestart = await request(`/api/sessions/${codeBuddySession.id}/messages?limit=100`);
    assert.equal(JSON.stringify(messagesAfterRestart).includes('REPLAY_SHOULD_NOT_APPEAR'), false);

    stage = 'CodeBuddy 离线降级';
    await rename(fake.entrypoint, fake.offlineEntrypoint);
    const historyOffline = await request(`/api/sessions/${codeBuddySession.id}/messages?limit=100`);
    assert.equal(Array.isArray(historyOffline), true);
    const publicOffline = await request(`/api/public/shares/${share.publicToken}`);
    assert.equal(publicOffline.state, 'active');
    stage = 'CodeBuddy 离线降级连接历史会话';
    const offlineClient = await openClient();
    offlineClient.ws.send(JSON.stringify({ type: 'subscribe', sessionId: codeBuddySession.id }));
    await offlineClient.inbox.wait((event) => event.type === 'sync_state' && event.sessionId === codeBuddySession.id);
    stage = 'CodeBuddy 离线降级拒绝发送';
    offlineClient.ws.send(JSON.stringify({ type: 'send', sessionId: codeBuddySession.id, messageId: randomUUID(), content: 'OFFLINE' }));
    await offlineClient.inbox.wait((event) => event.type === 'error' && event.sessionId === codeBuddySession.id);
    stage = 'CodeBuddy 离线时 Codex 继续工作';
    const codexOfflineClient = await openClient();
    codexOfflineClient.ws.send(JSON.stringify({ type: 'subscribe', sessionId: codexSession.id }));
    await codexOfflineClient.inbox.wait((event) => event.type === 'sync_state' && event.sessionId === codexSession.id);
    codexOfflineClient.ws.send(JSON.stringify({ type: 'send', sessionId: codexSession.id, messageId: randomUUID(), content: 'CODEX_STILL_AVAILABLE' }));
    await codexOfflineClient.inbox.wait((event) => event.type === 'message_complete' && /CODEX_STILL_AVAILABLE/.test(event.content));

    stage = 'CodeBuddy 恢复与 load replay';
    await rename(fake.offlineEntrypoint, fake.entrypoint);
    for (const socket of sockets.splice(0)) socket.close();
    await stopChild(relay);
    await startRelay();
    cookie = await login(baseUrl, token);
    const restoredClient = await openClient();
    restoredClient.ws.send(JSON.stringify({ type: 'subscribe', sessionId: codeBuddySession.id }));
    await restoredClient.inbox.wait((event) => event.type === 'sync_state' && event.sessionId === codeBuddySession.id);
    restoredClient.ws.send(JSON.stringify({ type: 'send', sessionId: codeBuddySession.id, messageId: randomUUID(), content: 'RESTORED_LOAD' }));
    const restored = await restoredClient.inbox.wait((event) => event.type === 'message_complete' && event.sessionId === codeBuddySession.id);
    assert.match(restored.content, /CodeBuddy:RESTORED_LOAD/);
    const finalMessages = await request(`/api/sessions/${codeBuddySession.id}/messages?limit=100`);
    assert.equal(JSON.stringify(finalMessages).includes('REPLAY_SHOULD_NOT_APPEAR'), false);

    stage = '汇总结果';
    return {
      ok: true,
      ports: { relay: relayPort, codex: codexAddress.port },
      projectCount: projects.length,
      engines: [codexSession.engine, codeBuddySession.engine],
      concurrentCompletion: true,
      perTurnModelSnapshots: true,
      codeBuddy: { permission: true, cancel: true, providerFailure: true, missingFinalAnswer: true, loadReplaySuppressed: true },
      codexRegression: true,
      offlineHistoryReadable: true,
      offlineShareReadable: true,
      restartInterruptedCodeBuddy: true,
      tempRoot,
    };
  } catch (error) {
    throw new Error(`${stage}失败：${error instanceof Error ? error.message : String(error)}\n${output.slice(-30).join('')}`);
  } finally {
    for (const socket of sockets) socket.close();
    await stopChild(relay);
    await new Promise<void>((resolve) => codex.close(() => resolve()));
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runMultiEngineVerification();
  console.log(JSON.stringify({ ...result, tempRoot: '已清理' }, null, 2));
}
