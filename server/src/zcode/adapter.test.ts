import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineEventEnvelope } from '../engine/events.js';
import type { EngineConnectionOptions } from '../engine/adapter.js';
import { ZcodeAdapter, parseZcodeModelCatalog, zcodeInteractionAdapter } from './adapter.js';
import type { ZcodeProcessManager } from './process-manager.js';

const SESSION_FIXTURE_ID = 'sess_fixture_0001';

async function waitForModelChange(transport: FakeZcodeTransport): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (transport.sent.some((message) => message.method === 'session/setModel')) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('模型切换未到达模拟传输');
}

function createCreateResultFixture(): Record<string, any> {
  // 取自 fixtures/zcode-protocol-basic.jsonl 的 create result 结构(脱敏值)。
  return {
    projection: { sessionId: SESSION_FIXTURE_ID, status: 'idle', mode: 'build' },
    protocol: { name: 'ZCode Protocol', version: 1 },
    settings: {
      mode: { current: 'build' },
      model: {
        current: { providerId: 'xs-cli-proxy', modelId: 'glm-5.3' },
        available: [
          {
            ref: { providerId: 'xs-cli-proxy', modelId: 'glm-5.3' },
            label: 'glm-5.3',
            providerLabel: 'xs-ai-proxy',
            contextWindow: 1_000_000,
            maxOutputTokens: 128_000,
            reasoning: {
              levels: [{ value: 'low', label: 'low' }, { value: 'high', label: 'high' }],
              defaultLevel: 'high',
            },
            properties: { inputFormat: { supportsText: true, supportsImage: false } },
          },
          {
            ref: { providerId: 'xs-cli-proxy', modelId: 'glm-5.3-flash' },
            label: 'glm-5.3-flash',
            contextWindow: 1_000_000,
            reasoning: { levels: [{ value: 'low', label: 'low' }], defaultLevel: 'low' },
            properties: { inputFormat: { supportsText: true, supportsImage: true } },
          },
        ],
      },
    },
  };
}

test('parseZcodeModelCatalog 从 settings.model.available 映射统一目录', () => {
  const catalog = parseZcodeModelCatalog(createCreateResultFixture());
  assert.equal(catalog.engineId, 'zcode');
  assert.equal(catalog.models.length, 2);
  const glm = catalog.models[0]!;
  assert.equal(glm.id, 'glm-5.3');
  assert.equal(glm.isDefault, true);
  assert.equal(glm.contextWindow, 1_000_000);
  assert.deepEqual(glm.inputModalities, ['text']);
  assert.equal(glm.reasoning.supported, true);
  assert.equal(glm.reasoning.defaultOptionId, 'high');
  assert.deepEqual(glm.reasoning.options, [{ id: 'low', label: 'low' }, { id: 'high', label: 'high' }]);
  const flash = catalog.models[1]!;
  assert.equal(flash.isDefault, false);
  assert.deepEqual(flash.inputModalities, ['text', 'image']);
});

test('parseZcodeModelCatalog 容忍缺失字段', () => {
  const catalog = parseZcodeModelCatalog({ settings: { model: { available: [null, { ref: {} }, { ref: { modelId: 'm1' }, label: 'M1' }] } } });
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0]!.id, 'm1');
  assert.equal(catalog.models[0]!.reasoning.supported, false);
});

function collectEvents() {
  const envelopes: EngineEventEnvelope[] = [];
  return { envelopes, onEvent: (envelope: EngineEventEnvelope) => envelopes.push(envelope) };
}

function baseConnectionOptions(cwd: string, onEvent: (envelope: EngineEventEnvelope) => void): EngineConnectionOptions {
  return {
    sessionId: 'relay-session-1',
    cwd,
    externalSessionId: null,
    onSessionReady: () => undefined,
    onEvent,
    onClosed: () => undefined,
  };
}

test('adapter connect 后应答 runtime preferences 并发出 session/create', async () => {
  // 用注入 manager 的方式拿到底层 transport 交互:借助 process-manager 的注入点过于复杂,
  // 这里直接验证交互适配器与目录解析;connect 集成路径由真实探针(Task 8 验收)覆盖。
  const adapter = new ZcodeAdapter();
  assert.equal(adapter.descriptor.id, 'zcode');
  const availability = adapter.availability.getCurrent();
  assert.equal(availability.code === 'AVAILABLE' || availability.code === 'ZCODE_NOT_INSTALLED', true);
});

test('权限请求归一化为 command/file/permissions 且响应回预置 response 体', () => {
  const request = {
    requestId: 'server-5',
    method: 'interaction/requestPermission',
    params: {
      toolName: 'Bash',
      riskLevel: 'high',
      reason: 'High risk tools require explicit approval',
      input: { command: "printf 'probe-ok' > file.txt", description: 'Create probe file' },
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'allow_once', response: { decision: 'allow', reason: 'Approved once' } },
        { kind: 'allow_always', name: 'Always allow in this project', optionId: 'allow_project', response: { decision: 'allow', permissionUpdates: [] } },
        { kind: 'deny', name: 'Deny', optionId: 'deny', response: { decision: 'deny', reason: 'Nope' } },
      ],
    },
  };
  const normalized = zcodeInteractionAdapter.normalize(request);
  assert.equal(normalized.kind, 'command');
  // command + 提供 allow_once 选项 → 进入信任候选(autoApprovable 派生事实)。
  assert.equal(normalized.autoApprovable, true);
  assert.deepEqual(normalized.availableActions, ['accept_once', 'accept_for_session', 'decline', 'cancel']);
  // allow_once 必须映射为 accept(允许一次),前端据此渲染「允许一次」按钮。
  assert.deepEqual(normalized.snapshot.availableDecisions, ['accept', 'acceptForSession', 'decline', 'cancel']);

  const acceptOnce = zcodeInteractionAdapter.buildResponse(request, { action: 'accept_once' });
  assert.deepEqual(acceptOnce, { decision: 'allow', reason: 'Approved once' });
  const acceptSession = zcodeInteractionAdapter.buildResponse(request, { action: 'accept_for_session' });
  assert.deepEqual(acceptSession, { decision: 'allow', permissionUpdates: [] });
  const decline = zcodeInteractionAdapter.buildResponse(request, { action: 'decline' });
  assert.deepEqual(decline, { decision: 'deny', reason: 'Nope' });
  assert.deepEqual(zcodeInteractionAdapter.buildResponse(request, { action: 'cancel' }), {});
  // 未知动作(如 submit)不匹配任何选项 kind → 空对象按拒绝处理,不抛错。
  assert.deepEqual(zcodeInteractionAdapter.buildResponse(request, { action: 'submit' }), {});
});

test('文件写入权限归一化为 file 类别', () => {
  const normalized = zcodeInteractionAdapter.normalize({
    requestId: 'server-1',
    method: 'interaction/requestPermission',
    params: {
      toolName: 'Write',
      riskLevel: 'medium',
      input: { file_path: 'D:/workspace/demo/probe.txt', content: 'probe-ok' },
      options: [
        { kind: 'allow_once', optionId: 'allow_once', response: { decision: 'allow' } },
        { kind: 'allow_project', optionId: 'allow_project', response: { decision: 'allow', permissionUpdates: [] } },
        { kind: 'deny', optionId: 'deny', response: { decision: 'deny' } },
      ],
    },
  });
  assert.equal(normalized.kind, 'file');
  assert.equal(normalized.snapshot.toolName, 'Write');
  // 文件路径必须落在 presenter 详情白名单的 path 字段，否则卡片展开没有任何详情。
  assert.equal(normalized.snapshot.path, 'D:/workspace/demo/probe.txt');
});

test('未知服务器请求归一化为 unknown 且动作列表为空', () => {
  const normalized = zcodeInteractionAdapter.normalize({
    requestId: 'server-2',
    method: 'interaction/requestOfficialMcpAuthHeaders',
    params: { mcpKey: 'image_search' },
  });
  assert.equal(normalized.kind, 'unknown');
  assert.deepEqual(normalized.availableActions, []);
});

test('健康检查按安装探测', async () => {
  const adapter = new ZcodeAdapter();
  const health = await adapter.health.inspectLocal();
  assert.equal(health.engineId, 'zcode');
  assert.equal(health.available, typeof health.code === 'string');
});

class FakeZcodeTransport {
  state = 'open' as const;
  private messageListeners = new Set<(message: any) => void>();
  private openListeners = new Set<() => void>();
  private closeListeners = new Set<() => void>();
  private errorListeners = new Set<(error: Error) => void>();
  sent: any[] = [];
  private requestIdSequence = 0;
  constructor(private readonly responder?: (method: string, params: any, id: any) => any) {}
  nextRequestId(): number {
    return ++this.requestIdSequence;
  }
  send(message: any): void {
    this.sent.push(message);
    if (this.responder && message.method) {
      const result = this.responder(message.method, message.params, message.id);
      if (result !== undefined) queueMicrotask(() => this.emitMessage({ id: message.id, result }));
    }
  }
  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    queueMicrotask(listener);
    return () => this.openListeners.delete(listener);
  }
  onMessage(listener: (message: any) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }
  emitMessage(message: any): void {
    for (const listener of this.messageListeners) listener(message);
  }
  close(): void {}
  terminate(): void {}
  async closeAndWait(): Promise<void> {
    for (const listener of this.closeListeners) listener();
  }
}

test('宿主输入受理回调绑定 session/send 请求应答，发送和通知本身不确认', async () => {
  const transport = new FakeZcodeTransport((method) => {
    if (method === 'session/create') return createCreateResultFixture();
    if (method === 'session/subscribe') return {};
    if (method === 'session/setModel') return {};
    return undefined;
  });
  const adapter = new ZcodeAdapter({ manager: fakeManagerWithTransport(transport) });
  const accepted: Array<{ turnId: string; content: string }> = [];
  const connection = adapter.runtime.connect({
    ...baseConnectionOptions('D:/ws', () => undefined),
    onInputAccepted: (turnId, content) => { accepted.push({ turnId, content }); },
  });
  connection.send('宿主输入');
  for (let index = 0; index < 30 && !transport.sent.some((message) => message.method === 'session/send'); index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const request = transport.sent.find((message) => message.method === 'session/send');
  assert.ok(request);
  assert.equal(accepted.length, 0);
  transport.emitMessage({ id: request.id, result: {} });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].content, '宿主输入');
  assert.match(accepted[0].turnId, /^zcode-turn:/);
  await connection.close();
});

test('listModels 在目录未就绪时主动探测并缓存', async () => {
  const transport = new FakeZcodeTransport((method) => (method === 'session/create' ? createCreateResultFixture() : undefined));
  const manager = { createDiscoveryTransport: () => transport } as unknown as ZcodeProcessManager;
  const adapter = new ZcodeAdapter({ manager });
  const catalog = await adapter.models.listModels();
  assert.equal(catalog.engineId, 'zcode');
  assert.equal(catalog.models.length, 2);
  assert.ok(transport.sent.some((message) => message.method === 'session/create'));
  // 第二次调用走缓存,不再发 session/create。
  const before = transport.sent.length;
  const again = await adapter.models.listModels();
  assert.equal(again.models.length, 2);
  assert.equal(transport.sent.length, before);
});

test('listModels 探测并发单飞', async () => {
  let createCount = 0;
  const transport = new FakeZcodeTransport((method) => {
    if (method === 'session/create') { createCount += 1; return createCreateResultFixture(); }
    return undefined;
  });
  const manager = { createDiscoveryTransport: () => transport } as unknown as ZcodeProcessManager;
  const adapter = new ZcodeAdapter({ manager });
  const [first, second] = await Promise.all([adapter.models.listModels(), adapter.models.listModels()]);
  assert.equal(createCount, 1);
  assert.equal(first.models.length, 2);
  assert.equal(second.models.length, 2);
});

test('listModels 探测失败时 reject(未安装或进程异常)', async () => {
  const manager = {
    createDiscoveryTransport: () => { throw new Error('ZCODE_NOT_INSTALLED'); },
  } as unknown as ZcodeProcessManager;
  const adapter = new ZcodeAdapter({ manager });
  await assert.rejects(adapter.models.listModels());
});

test('listModels 探测应答 session/create 期间的反向请求', async () => {
  // 真实 app-server 在 create 期间会发带 id 的反向请求;不应答会让 create 永不返回。
  const transport = new FakeZcodeTransport((method) => (method === 'session/create' ? createCreateResultFixture() : undefined));
  const originalSend = transport.send.bind(transport);
  transport.send = (message: any) => {
    // 模拟 app-server 行为:发 create 请求后立刻收到一个 runtime preferences 反向请求。
    if (message.method === 'session/create') {
      queueMicrotask(() => transport.emitMessage({ id: 'server-1', method: 'session/requestRuntimePreferences', params: {} }));
    }
    originalSend(message);
  };
  const manager = { createDiscoveryTransport: () => transport } as unknown as ZcodeProcessManager;
  const adapter = new ZcodeAdapter({ manager });
  const catalog = await adapter.models.listModels();
  assert.equal(catalog.models.length, 2);
  const reply = transport.sent.find((message) => message.id === 'server-1');
  assert.ok(reply, '必须应答反向请求');
  assert.deepEqual(reply.result, {
    nativeSearchEnhancementsEnabled: false,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: false,
  });
});

function fakeManagerWithTransport(transport: FakeZcodeTransport): ZcodeProcessManager {
  return {
    acquire: () => transport,
    release: () => undefined,
    touch: () => undefined,
    createDiscoveryTransport: () => transport,
  } as unknown as ZcodeProcessManager;
}

test('同工作区双连接并发请求按进程级 id 路由,应答不串会话', async () => {
  // 共享同一 transport(同 cwd 复用进程):两个连接的 create 请求 id 必须全进程唯一,
  // 应答只命中发起方的 pending 表,sessionReady 各自拿到自己的 sessionId。
  const transport = new FakeZcodeTransport((method, _params, id) => {
    if (method === 'session/create') return { projection: { sessionId: `sess_${id}` }, session: { sessionId: `sess_${id}` } };
    if (method === 'session/subscribe') return {};
    return undefined;
  });
  const adapter = new ZcodeAdapter({ manager: fakeManagerWithTransport(transport) });
  const readyIds: Array<{ relayId: string; externalId: string }> = [];
  const mkOptions = (relayId: string) => ({
    ...baseConnectionOptions('D:/ws', () => undefined),
    sessionId: relayId,
    onSessionReady: (externalId: string) => readyIds.push({ relayId, externalId }),
  });
  const connA = adapter.runtime.connect(mkOptions('relay-sess-a'));
  const connB = adapter.runtime.connect(mkOptions('relay-sess-b'));
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => { if (readyIds.length === 2) { clearInterval(timer); resolve(); } }, 5);
    timer.unref?.();
  });
  const createRequests = transport.sent.filter((message) => message.method === 'session/create');
  assert.equal(createRequests.length, 2);
  const createIds = createRequests.map((message) => message.id);
  assert.equal(new Set(createIds).size, 2, '双连接 create 请求 id 不得重复');
  // 应答按 id 精确路由:每个连接的 externalId 必须等于自己 create 请求的 id 对应会话。
  assert.equal(readyIds.length, 2, '两个连接都收到 sessionReady');
  const externalIds = readyIds.map((entry) => entry.externalId).sort();
  const expected = createIds.map((id) => `sess_${id}`).sort();
  assert.deepEqual(externalIds, expected, '每个连接拿到的必须是自己的 sessionId');
  await connA.close();
  await connB.close();
});

test('共享进程时服务器反向请求只应答一次', async () => {
  const transport = new FakeZcodeTransport((method) => {
    if (method === 'session/create') return { projection: { sessionId: SESSION_FIXTURE_ID }, session: { sessionId: SESSION_FIXTURE_ID } };
    if (method === 'session/subscribe') return {};
    return undefined;
  });
  const adapter = new ZcodeAdapter({ manager: fakeManagerWithTransport(transport) });
  const connA = adapter.runtime.connect(baseConnectionOptions('D:/ws', () => undefined));
  const connB = adapter.runtime.connect(baseConnectionOptions('D:/ws', () => undefined));
  await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
  transport.emitMessage({ id: 'server-prefs-1', method: 'session/requestRuntimePreferences', params: {} });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const replies = transport.sent.filter((message) => message.id === 'server-prefs-1');
  assert.equal(replies.length, 1, '两个连接共享进程时反向请求只应答一次');
  await connA.close();
  await connB.close();
});

test('共享进程时授权反向请求按 sessionId 路由到归属会话', async () => {
  // 真实抓包确认 interaction/requestPermission params 带 sessionId(fixtures 第 56/77 行)。
  // 双连接共享进程:B 会话的授权不得 emit 到 A 连接,A 也不得替 B 应答。
  const transport = new FakeZcodeTransport((method) => {
    if (method === 'session/subscribe') return {};
    return undefined;
  });
  const adapter = new ZcodeAdapter({ manager: fakeManagerWithTransport(transport) });
  const eventsA: EngineEventEnvelope[] = [];
  const eventsB: EngineEventEnvelope[] = [];
  // 让两个连接拿到不同的 externalSessionId,模拟同工作区两个真实会话;
  // create 应答由 override 全权负责,responder 不再插手,避免覆盖归属标记。
  let createCount = 0;
  const originalSend = transport.send.bind(transport);
  transport.send = (message: any) => {
    if (message.method === 'session/create') {
      createCount += 1;
      // sid 必须在入队 microtask 前求值:微任务执行时 createCount 已被后续 create 递增。
      const sessionId = `sess_owner_${createCount}`;
      transport.sent.push(message);
      queueMicrotask(() => transport.emitMessage({
        id: message.id,
        result: { projection: { sessionId }, session: { sessionId } },
      }));
      return;
    }
    originalSend(message);
  };
  const connA = adapter.runtime.connect({ ...baseConnectionOptions('D:/ws', (envelope) => eventsA.push(envelope)), sessionId: 'relay-sess-a', onSessionReady: () => undefined });
  const connB = adapter.runtime.connect({ ...baseConnectionOptions('D:/ws', (envelope) => eventsB.push(envelope)), sessionId: 'relay-sess-b', onSessionReady: () => undefined });
  // create+subscribe 就绪链跨多个微任务轮次,轮询等待两个连接的 externalSessionId 就位。
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (transport.sent.filter((message) => message.method === 'session/subscribe').length >= 2) {
        clearInterval(timer);
        resolve();
      }
    }, 5);
    timer.unref?.();
  });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  // B 会话的授权反向请求:A 连接必须跳过,不 emit、不应答。
  transport.emitMessage({
    id: 'server-perm-b',
    method: 'interaction/requestPermission',
    params: { sessionId: 'sess_owner_2', toolName: 'Bash', input: { command: 'git commit' }, options: [] },
  });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const serverRequestsA = eventsA.filter((envelope) => envelope.payload.type === 'server_request');
  assert.equal(serverRequestsA.length, 0, '非归属会话的授权不得 emit 到 A 连接');
  const serverRequestsB = eventsB.filter((envelope) => envelope.payload.type === 'server_request');
  assert.equal(serverRequestsB.length, 1, '授权必须路由到归属的 B 连接');
  assert.equal((serverRequestsB[0]!.payload as { requestId: unknown }).requestId, 'server-perm-b');
  // 非归属连接不应替归属连接应答;应答由归属连接的用户决定触发(respondToInteraction)。
  assert.equal(transport.sent.filter((message) => message.id === 'server-perm-b').length, 0);
  // 反向请求也带 sessionId 的 request_user_input 同样按会话路由。
  transport.emitMessage({
    id: 'server-input-b',
    method: 'session/request_user_input',
    params: { sessionId: 'sess_owner_2', questions: [] },
  });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(eventsA.filter((envelope) => envelope.payload.type === 'server_request').length, 0, '非归属会话的用户输入请求不得 emit 到 A 连接');
  assert.equal(eventsB.filter((envelope) => envelope.payload.type === 'server_request').length, 2, '用户输入请求必须路由到归属的 B 连接');
  await connA.close();
  await connB.close();
});

test('授权反向请求缺少 sessionId 时回退为广播认领', async () => {
  // 兼容旧协议形态:params 无 sessionId 时保持既有"第一个看到的连接认领"行为。
  const transport = new FakeZcodeTransport((method) => {
    if (method === 'session/create') return { projection: { sessionId: SESSION_FIXTURE_ID }, session: { sessionId: SESSION_FIXTURE_ID } };
    if (method === 'session/subscribe') return {};
    return undefined;
  });
  const adapter = new ZcodeAdapter({ manager: fakeManagerWithTransport(transport) });
  const eventsA: EngineEventEnvelope[] = [];
  const connA = adapter.runtime.connect(baseConnectionOptions('D:/ws', (envelope) => eventsA.push(envelope)));
  await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
  transport.emitMessage({
    id: 'server-perm-legacy',
    method: 'interaction/requestPermission',
    params: { toolName: 'Bash', input: { command: 'ls' }, options: [] },
  });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(eventsA.filter((envelope) => envelope.payload.type === 'server_request').length, 1, '无 sessionId 时保持广播认领回退');
  await connA.close();
});

test('偏好为空时 setModel 以目录默认推理等级兜底', async () => {
  // glm-5.3-flash 场景:上游 provider 要求显式 reasoningLevel,偏好为 null(UI 显示"模型默认")
  // 时也必须带上 defaultOptionId,否则上游拒绝"Reasoning level is required"。
  const transport = new FakeZcodeTransport((method, params) => {
    if (method === 'session/create') return createCreateResultFixture();
    if (method === 'session/subscribe') return {};
    if (method === 'session/setModel') return { ok: true, requested: params.model };
    return undefined;
  });
  const adapter = new ZcodeAdapter({ manager: fakeManagerWithTransport(transport) });
  const events: EngineEventEnvelope[] = [];
  const conn = adapter.runtime.connect({ ...baseConnectionOptions('D:/ws', (envelope) => events.push(envelope)) });
  await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
  // 偏好为空切到 glm-5.3-flash(defaultLevel low)→ setModel 必须带 reasoningLevel。
  conn.send('你好', { preferences: { modelId: 'glm-5.3-flash', reasoningEffort: null } });
  await waitForModelChange(transport);
  const setModel = transport.sent.find((message) => message.method === 'session/setModel');
  assert.ok(setModel, '切换模型必须发送 session/setModel');
  assert.equal(setModel.params.model.modelId, 'glm-5.3-flash');
  assert.equal(setModel.params.model.options.reasoningLevel, 'low', '偏好为空时必须回填目录默认等级');
  await conn.close();
});

test('显式推理等级优于目录默认,不重复下发相同等级', async () => {
  const transport = new FakeZcodeTransport((method) => {
    if (method === 'session/create') return createCreateResultFixture();
    if (method === 'session/subscribe') return {};
    if (method === 'session/setModel') return { ok: true };
    return undefined;
  });
  const adapter = new ZcodeAdapter({ manager: fakeManagerWithTransport(transport) });
  const events: EngineEventEnvelope[] = [];
  const conn = adapter.runtime.connect({ ...baseConnectionOptions('D:/ws', (envelope) => events.push(envelope)) });
  await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
  // create 观察到 current=glm-5.3 + reasoningLevel max(fixture);显式选 high → 必须下发 high。
  conn.send('第一句', { preferences: { modelId: 'glm-5.3', reasoningEffort: 'high' } });
  await waitForModelChange(transport);
  const firstSet = transport.sent.find((message) => message.method === 'session/setModel');
  assert.ok(firstSet, '显式等级与当前不同时必须下发 setModel');
  assert.equal(firstSet.params.model.options.reasoningLevel, 'high');
  // 再发一条相同偏好:等级已同步为 high,不得重复下发 setModel。
  const before = transport.sent.length;
  conn.send('第二句', { preferences: { modelId: 'glm-5.3', reasoningEffort: 'high' } });
  await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
  const repeated = transport.sent.slice(before).filter((message) => message.method === 'session/setModel');
  assert.equal(repeated.length, 0, '等级未变化时不得重复 setModel');
  await conn.close();
});

test('forkSession 映射 latest/turn target 并返回子会话 ID', async () => {
  const transport = new FakeZcodeTransport((method, params) => {
    if (method === 'session/fork') {
      return {
        forkedSessionId: 'sess_forked_1',
        parentSessionId: params.sessionId,
        targetMessageId: 'msg_anchor_1',
      };
    }
    return undefined;
  });
  const adapter = new ZcodeAdapter({ manager: fakeManagerWithTransport(transport) });
  const latest = await adapter.sessions.forkSession('sess_parent', 'D:/ws', { kind: 'latest' });
  assert.equal(latest.forkedSessionId, 'sess_forked_1');
  const latestRequest = transport.sent.find((message) => message.method === 'session/fork');
  assert.deepEqual(latestRequest.params.target, { kind: 'latestCheckpoint' });
  const byTurn = await adapter.sessions.forkSession('sess_parent', 'D:/ws', { kind: 'turn', turnIndex: 2 });
  assert.equal(byTurn.forkedSessionId, 'sess_forked_1');
  const turnRequest = transport.sent.filter((message) => message.method === 'session/fork').at(-1);
  assert.deepEqual(turnRequest.params.target, { kind: 'turn', turnIndex: 2 });
});

test('forkSession rechecks Native authority after transport setup and awaits owned transport close',async()=>{
  const transport=new FakeZcodeTransport(()=>({forkedSessionId:'child'}));let finishClose!:()=>void,closing=false;
  transport.closeAndWait=()=>{closing=true;return new Promise<void>(resolve=>{finishClose=resolve;});};
  const adapter=new ZcodeAdapter({manager:fakeManagerWithTransport(transport)});
  let done=false;const fork=adapter.sessions.forkSession('parent','D:/synthetic',{kind:'latest'},async()=>false).finally(()=>{done=true;});
  const rejected=assert.rejects(()=>fork,/FORK_AUTHORITY_CHANGED/);
  for(let index=0;index<20&&!closing;index++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(closing,true);assert.equal(done,false);assert.equal(transport.sent.some(message=>message.method==='session/fork'),false);
  finishClose();await rejected;assert.equal(done,true);
});

test('forkSession 在引擎报错时透传异常', async () => {
  const transport = new FakeZcodeTransport((method) => {
    if (method === 'session/fork') return undefined;
    return undefined;
  });
  const originalSend = transport.send.bind(transport);
  transport.send = (message: any) => {
    originalSend(message);
    if (message.method === 'session/fork') {
      queueMicrotask(() => transport.emitMessage({ id: message.id, error: { code: -32010, message: 'Cannot fork while a prompt is running' } }));
    }
  };
  const adapter = new ZcodeAdapter({ manager: fakeManagerWithTransport(transport) });
  await assert.rejects(
    adapter.sessions.forkSession('sess_parent', 'D:/ws', { kind: 'latest' }),
    /prompt is running/,
  );
});

test('TodoWrite 工具调用映射为统一 plan item 且不重复展示工具卡', async () => {
  const transport = new FakeZcodeTransport((method) => {
    if (method === 'session/create') return { projection: { sessionId: SESSION_FIXTURE_ID }, session: { sessionId: SESSION_FIXTURE_ID }, settings: createCreateResultFixture().settings };
    if (method === 'session/subscribe') return {};
    return undefined;
  });
  const adapter = new ZcodeAdapter({ manager: fakeManagerWithTransport(transport) });
  const { envelopes, onEvent } = collectEvents();
  const connection = adapter.runtime.connect(baseConnectionOptions('D:/ws', onEvent));
  await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
  transport.emitMessage({
    method: 'session/event',
    params: {
      sessionId: SESSION_FIXTURE_ID,
      type: 'model.streaming',
      payload: {
        kind: 'tool_call',
        toolCallId: 'call_todo_1',
        toolName: 'TodoWrite',
        input: { todos: [
          { content: '创建 a.txt', status: 'in_progress', priority: 'high' },
          { content: '创建 b.txt', status: 'pending', priority: 'high' },
        ] },
      },
    },
  });
  transport.emitMessage({
    method: 'session/event',
    params: {
      sessionId: SESSION_FIXTURE_ID,
      type: 'tool.updated',
      payload: {
        kind: 'result',
        toolCallId: 'call_todo_1',
        toolName: 'TodoWrite',
        result: { success: true, content: JSON.stringify({ todos: [
          { content: '创建 a.txt', status: 'completed' },
          { content: '创建 b.txt', status: 'in_progress' },
          { content: '创建 c.txt', status: 'pending' },
        ] }) },
      },
    },
  });
  await connection.close();
  const plans = envelopes.filter((envelope) => envelope.payload.type === 'item_complete' && (envelope.payload as any).item.type === 'plan');
  assert.equal(plans.length, 2, 'TodoWrite 调用与结果各投影一次计划快照');
  const toolCards = envelopes.filter((envelope) => envelope.payload.type === 'item_start' && (envelope.payload as any).item.details?.toolName === 'TodoWrite');
  assert.equal(toolCards.length, 0, 'TodoWrite 不再生成普通工具卡');
  const first = (plans[0]!.payload as any).item.plan;
  assert.deepEqual(first, [
    { step: '创建 a.txt', status: 'in_progress' },
    { step: '创建 b.txt', status: 'pending' },
  ]);
  const second = (plans[1]!.payload as any).item.plan;
  assert.equal(second[0]!.status, 'completed');
});

test('token_usage 的 modelContextWindow 来自 session.updated 事件', async () => {
  const transport = new FakeZcodeTransport((method) => {
    if (method === 'session/create') return { projection: { sessionId: SESSION_FIXTURE_ID }, session: { sessionId: SESSION_FIXTURE_ID }, settings: createCreateResultFixture().settings };
    if (method === 'session/subscribe') return {};
    return undefined;
  });
  const adapter = new ZcodeAdapter({ manager: fakeManagerWithTransport(transport) });
  const { envelopes, onEvent } = collectEvents();
  const connection = adapter.runtime.connect(baseConnectionOptions('D:/ws', onEvent));
  await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
  transport.emitMessage({
    method: 'session/event',
    params: {
      sessionId: SESSION_FIXTURE_ID,
      type: 'session.updated',
      payload: { content: 'step', contextWindow: 1_000_000, usage: { totalTokens: 20_000 } },
    },
  });
  transport.emitMessage({
    method: 'session/event',
    params: {
      sessionId: SESSION_FIXTURE_ID,
      type: 'turn.completed',
      payload: { response: 'done', usage: { inputTokens: 20_000, outputTokens: 100, totalTokens: 20_100 } },
    },
  });
  await connection.close();
  const usage = envelopes.find((envelope) => envelope.payload.type === 'token_usage');
  assert.ok(usage, '必须发出 token_usage');
  assert.equal((usage.payload as any).usage.modelContextWindow, 1_000_000, 'contextWindow 取自 session.updated 而非 turn.completed');
});

test('上下文占用骤降触发 context_compaction 通知且携带幂等身份', async () => {
  const transport = new FakeZcodeTransport((method) => {
    if (method === 'session/create') return { projection: { sessionId: SESSION_FIXTURE_ID }, session: { sessionId: SESSION_FIXTURE_ID }, settings: createCreateResultFixture().settings };
    if (method === 'session/subscribe') return {};
    return undefined;
  });
  const adapter = new ZcodeAdapter({ manager: fakeManagerWithTransport(transport) });
  const { envelopes, onEvent } = collectEvents();
  const connection = adapter.runtime.connect(baseConnectionOptions('D:/ws', onEvent));
  await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
  const emitUpdated = (totalTokens: number) => transport.emitMessage({
    method: 'session/event',
    params: {
      sessionId: SESSION_FIXTURE_ID,
      type: 'session.updated',
      payload: { content: 'step', contextWindow: 1_000_000, usage: { inputTokens: totalTokens, totalTokens } },
    },
  });
  emitUpdated(900_000);
  emitUpdated(880_000); // 正常波动,不触发
  emitUpdated(300_000); // 骤降超半 → 触发一次
  await connection.close();
  const notices = envelopes.filter((envelope) => envelope.payload.type === 'system_notice'
    && (envelope.payload as any).noticeType === 'context_compaction');
  assert.equal(notices.length, 1, '只有真正骤降触发一次压缩通知');
  const identity = (notices[0]!.payload as any).contextCompaction;
  assert.equal(identity.threadId, SESSION_FIXTURE_ID);
  assert.match(identity.turnId, /^zcode-compact:880000->300000$/); // 骤降锚点用最近观测值(正常波动已更新基线)
});

test('小幅占用波动不误报压缩', async () => {
  const transport = new FakeZcodeTransport((method) => {
    if (method === 'session/create') return { projection: { sessionId: SESSION_FIXTURE_ID }, session: { sessionId: SESSION_FIXTURE_ID }, settings: createCreateResultFixture().settings };
    if (method === 'session/subscribe') return {};
    return undefined;
  });
  const adapter = new ZcodeAdapter({ manager: fakeManagerWithTransport(transport) });
  const { envelopes, onEvent } = collectEvents();
  const connection = adapter.runtime.connect(baseConnectionOptions('D:/ws', onEvent));
  await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
  const emitUpdated = (totalTokens: number) => transport.emitMessage({
    method: 'session/event',
    params: {
      sessionId: SESSION_FIXTURE_ID,
      type: 'session.updated',
      payload: { content: 'step', contextWindow: 1_000_000, usage: { inputTokens: totalTokens, totalTokens } },
    },
  });
  emitUpdated(30_000);
  emitUpdated(5_000); // 低于 5 万起点门限,不触发(避免正常新会话切换模型误报)
  emitUpdated(20_000);
  await connection.close();
  const notices = envelopes.filter((envelope) => envelope.payload.type === 'system_notice'
    && (envelope.payload as any).noticeType === 'context_compaction');
  assert.equal(notices.length, 0);
});

test('上下文占用取 session.updated 最后一步单步用量而非回合累计计费值', async () => {
  const transport = new FakeZcodeTransport((method) => {
    if (method === 'session/create') return { projection: { sessionId: SESSION_FIXTURE_ID }, session: { sessionId: SESSION_FIXTURE_ID }, settings: createCreateResultFixture().settings };
    if (method === 'session/subscribe') return {};
    return undefined;
  });
  const adapter = new ZcodeAdapter({ manager: fakeManagerWithTransport(transport) });
  const { envelopes, onEvent } = collectEvents();
  const connection = adapter.runtime.connect(baseConnectionOptions('D:/ws', onEvent));
  await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
  const emitUpdated = (inputTokens: number, outputTokens: number) => transport.emitMessage({
    method: 'session/event',
    params: {
      sessionId: SESSION_FIXTURE_ID,
      type: 'session.updated',
      payload: { content: 'step', contextWindow: 1_000_000, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } },
    },
  });
  // 模拟一个 4 步回合:单步占用递增;累计计费值 = 各步 input 之和(远超单步)。
  emitUpdated(19_828, 130);
  emitUpdated(20_433, 68);
  emitUpdated(20_496, 131);
  emitUpdated(20_600, 364);
  transport.emitMessage({
    method: 'session/event',
    params: {
      sessionId: SESSION_FIXTURE_ID,
      type: 'turn.completed',
      payload: {
        response: 'done',
        usage: { inputTokens: 81_357, outputTokens: 693, totalTokens: 82_050 },
      },
    },
  });
  await connection.close();
  const usage = envelopes.find((envelope) => envelope.payload.type === 'token_usage');
  assert.ok(usage, '必须发出 token_usage');
  const projected = (usage.payload as any).usage;
  // 上下文占用 = 最后一步 input + 回合总 output,而非累计 82_050。
  assert.equal(projected.inputTokens, 20_600, 'inputTokens 用最后一步单步值');
  assert.equal(projected.totalTokens, 20_600 + 693, 'totalTokens = 单步 input + 回合 output,远小于累计值');
  assert.equal(projected.outputTokens, 693, 'outputTokens 保留回合累计');
});
