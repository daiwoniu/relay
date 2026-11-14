import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineEvent } from '../engine/adapter.js';
import type { EngineEventEnvelope } from '../engine/events.js';
import type { JsonRpcEnvelope, JsonRpcTransport, JsonRpcTransportState } from '../engine/transports/transport.js';
import { CodeBuddyAdapter, DEFAULT_PROMPT_IDLE_TIMEOUT_MS } from './adapter.js';
import type { CodeBuddyProcessManager, ManagedCodeBuddyTransport } from './process-manager.js';

test('CodeBuddy interactions 分面按 ACP option 标准化权限请求', () => {
  const interactions = new CodeBuddyAdapter().interactions;
  const normalized = interactions.normalize({
    requestId: 'permission-1',
    method: 'session/request_permission',
    params: {
      toolCall: {
        toolCallId: 'tool-1',
        rawInput: { command: 'npm test', description: '运行测试', password: 'secret' },
        _meta: { 'codebuddy.ai/toolName': 'terminal', accessToken: 'secret' },
      },
      options: [
        { optionId: 'once-id', kind: 'allow_once', name: '允许一次' },
        { optionId: 'always-id', kind: 'allow_always', name: '本会话允许' },
        { optionId: 'reject-id', kind: 'reject_once', name: '拒绝' },
        { optionId: 'invalid-id', kind: 'future_kind' },
      ],
    },
  });

  assert.equal(normalized.kind, 'command');
  assert.equal(normalized.autoApprovable, true);
  assert.deepEqual(normalized.availableActions, ['accept_once', 'accept_for_session', 'decline', 'cancel']);
  assert.deepEqual(normalized.snapshot.rawInput, { command: 'npm test', description: '运行测试' });
  assert.doesNotMatch(JSON.stringify(normalized.snapshot), /password|accessToken|secret|tool-1|once-id|always-id|reject-id/);
});

test('CodeBuddy interactions 分面分类文件、网络、一般权限、用户输入和 unknown', () => {
  const interactions = new CodeBuddyAdapter().interactions;
  const normalizePermission = (toolName: string, rawInput: Record<string, unknown> = {}) => interactions.normalize({
    requestId: toolName,
    method: 'session/request_permission',
    params: {
      toolCall: { rawInput, _meta: { 'codebuddy.ai/toolName': toolName } },
      options: [{ optionId: 'once', kind: 'allow_once' }],
    },
  });
  assert.equal(normalizePermission('write', { path: 'a.ts' }).kind, 'file');
  assert.equal(normalizePermission('webfetch').kind, 'permissions');
  assert.equal(normalizePermission('custom-tool').kind, 'permissions');

  const userInput = interactions.normalize({ requestId: 2, method: 'session/request_user_input', params: { message: '请选择' } });
  const unknown = interactions.normalize({ requestId: 3, method: 'future/request', params: {} });
  assert.equal(userInput.kind, 'user_input');
  assert.deepEqual(userInput.availableActions, ['submit', 'cancel']);
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.autoApprovable, false);
});

test('CodeBuddy interactions 分面按 ACP optionId 构造响应且拒绝不支持动作', () => {
  const interactions = new CodeBuddyAdapter().interactions;
  const permission = {
    requestId: 1,
    method: 'session/request_permission',
    params: { options: [
      { optionId: 'once-id', kind: 'allow_once' },
      { optionId: 'always-id', kind: 'allow_always' },
      { optionId: 'reject-id', kind: 'reject_once' },
    ] },
  };
  assert.deepEqual(interactions.buildResponse(permission, { action: 'accept_once' }), { outcome: { outcome: 'selected', optionId: 'once-id' } });
  assert.deepEqual(interactions.buildResponse(permission, { action: 'accept_for_session' }), { outcome: { outcome: 'selected', optionId: 'always-id' } });
  assert.deepEqual(interactions.buildResponse(permission, { action: 'decline' }), { outcome: { outcome: 'selected', optionId: 'reject-id' } });
  assert.deepEqual(interactions.buildResponse(permission, { action: 'cancel' }), { outcome: { outcome: 'cancelled' } });
  assert.throws(() => interactions.buildResponse({ ...permission, params: { options: [] } }, { action: 'accept_once' }), /不可用/);
  assert.throws(() => interactions.buildResponse(permission, { action: 'submit' }), /不可用/);

  const userInput = { requestId: 2, method: 'session/request_user_input', params: {} };
  assert.deepEqual(interactions.buildResponse(userInput, { action: 'submit', answers: { q1: ['yes'] } }), { answers: { q1: ['yes'] } });
  assert.deepEqual(interactions.buildResponse(userInput, { action: 'cancel' }), { outcome: { outcome: 'cancelled' } });
  assert.throws(() => interactions.buildResponse({ requestId: 3, method: 'future/request', params: {} }, { action: 'cancel' }), /暂不支持/);
});

test('CodeBuddy prompt watchdog defaults to the official 2.148 twenty-minute idle timeout', () => {
  assert.equal(DEFAULT_PROMPT_IDLE_TIMEOUT_MS, 20 * 60_000);
});

class FakeTransport implements ManagedCodeBuddyTransport {
  state: JsonRpcTransportState = 'connecting';
  sent: JsonRpcEnvelope[] = [];
  terminateCount = 0;
  private openListeners = new Set<() => void>();
  private messageListeners = new Set<(message: JsonRpcEnvelope) => void>();
  private closeListeners = new Set<() => void>();
  private errorListeners = new Set<(error: Error) => void>();

  send(message: JsonRpcEnvelope): void { this.sent.push(message); }
  open(): void { this.state = 'open'; for (const listener of this.openListeners) listener(); }
  receive(message: JsonRpcEnvelope): void { for (const listener of this.messageListeners) listener(message); }
  close(): void { this.state = 'closed'; for (const listener of this.closeListeners) listener(); }
  fail(error: Error): void { for (const listener of this.errorListeners) listener(error); }
  terminate(): void { this.terminateCount += 1; this.close(); }
  async closeAndWait(): Promise<void> { this.close(); }
  diagnostic(): string { return ''; }
  onOpen(listener: () => void): () => void { this.openListeners.add(listener); return () => this.openListeners.delete(listener); }
  onMessage(listener: (message: JsonRpcEnvelope) => void): () => void { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
  onClose(listener: () => void): () => void { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  onError(listener: (error: Error) => void): () => void { this.errorListeners.add(listener); return () => this.errorListeners.delete(listener); }
}

function createHarness(externalSessionId: string | null = null, requestTimeoutMs = 1_000, lifecycle: {
  cancelConfirmationTimeoutMs?: number;
  promptIdleTimeoutMs?: number;
  listModels?: () => Promise<any>;
} = {}) {
  const transport = new FakeTransport();
  const busyStates: boolean[] = [];
  const manager = {
    getOrCreate: () => transport,
    release: async () => { transport.close(); },
    touch: () => true,
    setBusy: (_sessionId: string, busy: boolean) => { busyStates.push(busy); return true; },
  } as unknown as CodeBuddyProcessManager;
  const events: EngineEvent[] = [];
  const envelopes: EngineEventEnvelope[] = [];
  const readyIds: string[] = [];
  const acceptedInputs: Array<{ turnId: string; content: string }> = [];
  const milestones: string[] = [];
  const adapter = new CodeBuddyAdapter({
    manager,
    requestTimeoutMs,
    getAvailability: () => ({ available: true, code: 'AVAILABLE' }),
    ...lifecycle,
  });
  const connection = adapter.runtime.connect({
    sessionId: 'relay-session',
    cwd: 'D:/workspace',
    externalSessionId,
    onSessionReady: (id) => readyIds.push(id),
    onInputAccepted: (turnId, content) => { acceptedInputs.push({ turnId, content }); },
    onEvent: (event) => { envelopes.push(event); events.push(event.payload); },
    onClosed: () => undefined,
    onPerformanceMilestone: (milestone) => milestones.push(milestone),
  });
  return { adapter, transport, connection, events, envelopes, readyIds, busyStates, milestones, acceptedInputs };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function initialize(harness: ReturnType<typeof createHarness>, loaded = false, sessionResult: Record<string, unknown> = {}): Promise<void> {
  harness.transport.open();
  await tick();
  assert.equal(harness.transport.sent[0]?.method, 'initialize');
  harness.transport.receive({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: {} } });
  await tick();
  assert.equal(harness.transport.sent[1]?.method, loaded ? 'session/load' : 'session/new');
  harness.transport.receive({ jsonrpc: '2.0', id: 2, result: loaded ? sessionResult : { sessionId: 'cb-session', ...sessionResult } });
  await tick();
}

test('初始化、新建 session、流式回答与成功终态映射为统一事件', async () => {
  const harness = createHarness();
  await initialize(harness);
  assert.deepEqual(harness.readyIds, ['cb-session']);
  harness.connection.send('你好');
  await tick();
  assert.equal(harness.transport.sent[2]?.method, 'session/prompt');
  assert.deepEqual(harness.acceptedInputs, []);
  assert.deepEqual(harness.milestones, ['transport_opened', 'protocol_initialized', 'external_session_ready', 'provider_request_sent']);
  harness.transport.receive({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'cb-session', update: { sessionUpdate: 'agent_thought_chunk', messageId: 'm1', content: { type: 'text', text: '思考' } },
  } });
  harness.transport.receive({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'cb-session', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: '完成' } },
  } });
  harness.transport.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn', _meta: { 'codebuddy.ai/outcome': 'SUCCESS' } } });
  await tick();
  assert.equal(harness.events.some((event) => event.type === 'delta' && event.phase === 'commentary'), true);
  assert.equal(harness.events.find((event) => event.type === 'delta' && event.phase === 'commentary' && event.itemId === 'm1:commentary')?.type, 'delta');
  assert.equal(harness.events.some((event) => event.type === 'message_complete' && event.content === '完成'), true);
  assert.deepEqual(harness.acceptedInputs, [{ turnId: harness.events.find((event) => event.type === 'message_complete')?.turnId, content: '你好' }]);
  assert.equal(
    harness.events.find((event) => event.type === 'message_complete')?.finalAnswerItemId,
    'm1',
  );
  assert.equal(harness.envelopes.find((event) => event.payload.type === 'request_forwarded')?.meta.source, 'local');
  assert.equal(harness.envelopes.find((event) => event.payload.type === 'delta')?.meta.source, 'realtime');
  assert.equal(harness.envelopes.find((event) => event.payload.type === 'message_complete')?.meta.source, 'request_response');
  assert.deepEqual(harness.envelopes.map((event) => event.meta.sequence), harness.envelopes.map((_event, index) => index + 1));
  harness.connection.close();
});

test('session/new 返回布尔型 configOption 时会话照常建立', async () => {
  const harness = createHarness();
  await initialize(harness, false, {
    models: { currentModelId: 'default-model', availableModels: [{ modelId: 'default-model', name: 'Default' }] },
    configOptions: [
      { id: 'thought_level', category: 'thought_level', currentValue: 'medium', options: [{ value: 'medium', name: '中' }] },
      { id: 'multitask', type: 'boolean', category: '_codebuddy.ai/multitask', currentValue: false },
    ],
  });
  assert.deepEqual(harness.readyIds, ['cb-session']);
  assert.equal(harness.events.some((event) => event.type === 'error'), false);
  harness.connection.send('你好');
  await tick();
  harness.transport.receive({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'cb-session', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: '完成' } },
  } });
  harness.transport.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
  await tick();
  assert.equal(harness.events.some((event) => event.type === 'error'), false);
  assert.equal(harness.events.some((event) => event.type === 'message_complete' && event.content === '完成'), true);
});

test('自动选模复用连接时每轮 prompt 前上报当前模型', async () => {
  const harness = createHarness();
  await initialize(harness, false, {
    models: { currentModelId: 'default-model', availableModels: [{ modelId: 'default-model', name: 'Default' }] },
  });
  harness.connection.send('第一轮', { preferences: { modelId: null, reasoningEffort: null } });
  await tick();
  harness.transport.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
  await tick();
  harness.connection.send('第二轮', { preferences: { modelId: null, reasoningEffort: null } });
  await tick();

  assert.equal(harness.events.filter((event) => event.type === 'model_info' && event.model === 'Default').length, 1);
  assert.equal(harness.events.filter((event) => event.type === 'model_info' && event.model === 'default-model').length, 2);
  assert.deepEqual(harness.transport.sent.filter((message) => message.method === 'session/prompt').map((message) => (message.params as any)?.prompt), [
    [{ type: 'text', text: '第一轮' }],
    [{ type: 'text', text: '第二轮' }],
  ]);
});

test('显式配置后切回自动会在 prompt 前恢复 ACP 会话基线', async () => {
  const harness = createHarness();
  await initialize(harness, false, {
    models: { currentModelId: 'default-model', availableModels: [
      { modelId: 'default-model', name: 'Default' }, { modelId: 'hy3-x', name: 'HY3 X' },
    ] },
    configOptions: [{
      id: 'thought_level', category: 'thought_level', currentValue: 'medium',
      options: [{ value: 'medium', name: '中' }, { value: 'high', name: '高' }],
    }],
  });
  harness.connection.send('配置后发送', { preferences: { modelId: 'hy3-x', reasoningEffort: 'high' } });
  await tick();
  assert.deepEqual(harness.transport.sent.slice(2).map((message) => message.method), ['session/set_model']);
  harness.transport.receive({ jsonrpc: '2.0', id: 3, result: { modelId: 'hy3-x' } });
  await tick();
  assert.equal(harness.transport.sent[3]?.method, 'session/set_config_option');
  assert.deepEqual(harness.transport.sent[3]?.params, { sessionId: 'cb-session', configId: 'thought_level', value: 'high' });
  harness.transport.receive({ jsonrpc: '2.0', id: 4, result: {} });
  await tick();
  assert.equal(harness.transport.sent[4]?.method, 'session/prompt');
  assert.equal(harness.events.some((event) => event.type === 'model_info' && event.model === 'hy3-x'), true);
  harness.transport.receive({ jsonrpc: '2.0', id: 5, result: { stopReason: 'end_turn' } });
  await tick();
  harness.connection.send('自动发送', { preferences: { modelId: null, reasoningEffort: null } });
  await tick();
  assert.equal(harness.transport.sent[5]?.method, 'session/set_model');
  assert.deepEqual(harness.transport.sent[5]?.params, { sessionId: 'cb-session', modelId: 'default-model' });
  harness.transport.receive({ jsonrpc: '2.0', id: 6, result: { modelId: 'default-model' } });
  await tick();
  assert.equal(harness.transport.sent[6]?.method, 'session/set_config_option');
  assert.deepEqual(harness.transport.sent[6]?.params, { sessionId: 'cb-session', configId: 'thought_level', value: 'medium' });
  harness.transport.receive({ jsonrpc: '2.0', id: 7, result: {} });
  await tick();
  assert.equal(harness.transport.sent[7]?.method, 'session/prompt');
  const restoredModelEvent = [...harness.events].reverse().find((event) => event.type === 'model_info');
  assert.deepEqual(restoredModelEvent, {
    type: 'model_info', model: 'default-model', modelProvider: 'CodeBuddy', reasoningEffort: 'medium',
  });
});

test('重载会话的自动模式使用发现目录默认值而不是已持久化显式值', async () => {
  const catalog = {
    engineId: 'codebuddy' as const, fetchedAt: 1, stale: false,
    models: [{
      id: 'default-model', displayName: 'Default', isDefault: true, inputModalities: ['text' as const],
      reasoning: { supported: true, scope: 'session' as const, defaultOptionId: 'medium', options: [{ id: 'medium', label: '中' }] },
    }],
  };
  const harness = createHarness('cb-session', 1_000, { listModels: async () => catalog });
  await harness.adapter.models!.listModels();
  await initialize(harness, true, {
    models: { currentModelId: 'hy3-x', availableModels: [
      { modelId: 'default-model', name: 'Default' }, { modelId: 'hy3-x', name: 'HY3 X' },
    ] },
    configOptions: [{
      id: 'thought_level', category: 'thought_level', currentValue: 'high',
      options: [{ value: 'medium', name: '中' }, { value: 'high', name: '高' }],
    }],
  });
  harness.connection.send('恢复自动', { preferences: { modelId: null, reasoningEffort: null } });
  await tick();
  assert.deepEqual(harness.transport.sent[2], {
    jsonrpc: '2.0', id: 3, method: 'session/set_model',
    params: { sessionId: 'cb-session', modelId: 'default-model' },
  });
});

test('显式配置失败时不发送 prompt 并形成真实错误', async () => {
  const harness = createHarness();
  await initialize(harness);
  harness.connection.send('不能降级', { preferences: { modelId: 'missing', reasoningEffort: null } });
  await tick();
  harness.transport.receive({ jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'model unavailable' } });
  await tick();
  assert.equal(harness.transport.sent.some((message) => message.method === 'session/prompt'), false);
  assert.equal(harness.events.some((event) => event.type === 'error'), true);
});

test('连接重建后 CodeBuddy turn ID 仍保持全局唯一', async () => {
  const first = createHarness();
  await initialize(first);
  first.connection.send('第一轮');
  await tick();
  first.transport.receive({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'cb-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第一条回复' } },
  } });
  first.transport.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
  await tick();

  const second = createHarness('cb-session');
  await initialize(second, true);
  second.connection.send('第二轮');
  await tick();
  second.transport.receive({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'cb-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第二条回复' } },
  } });
  second.transport.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
  await tick();

  const firstTurnId = first.events.find((event) => event.type === 'message_complete')?.turnId;
  const secondTurnId = second.events.find((event) => event.type === 'message_complete')?.turnId;
  assert.match(firstTurnId || '', /^codebuddy-turn:[0-9a-f-]{36}$/);
  assert.match(secondTurnId || '', /^codebuddy-turn:[0-9a-f-]{36}$/);
  assert.notEqual(firstTurnId, secondTurnId);
  first.connection.close();
  second.connection.close();
});

test('session/prompt 不继承握手固定超时且任务期间保持进程忙碌', async () => {
  const harness = createHarness(null, 20);
  await initialize(harness);
  harness.connection.send('长任务');
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(harness.busyStates, [true]);
  assert.equal(harness.events.some((event) => event.type === 'error'), false);
  harness.transport.receive({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'cb-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成' } },
  } });
  harness.transport.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
  await tick();
  assert.deepEqual(harness.busyStates, [true, false]);
  assert.equal(harness.events.some((event) => event.type === 'message_complete'), true);
  harness.connection.close();
});

test('业务失败、空正文、进程退出与重复响应各只保留一个终态候选', async () => {
  const business = createHarness();
  await initialize(business);
  business.connection.send('业务失败');
  await tick();
  business.transport.receive({ jsonrpc: '2.0', id: 3, result: {
    stopReason: 'end_turn', _meta: { 'codebuddy.ai/businessFailed': true },
  } });
  await tick();
  assert.deepEqual(business.events.filter((event) => event.type === 'error').map((event) => (
    event.type === 'error' ? event.diagnostic.code : ''
  )), [undefined]);
  assert.equal(business.events.find((event) => event.type === 'error')?.diagnostic.providerClass, 'unknown');

  const empty = createHarness();
  await initialize(empty);
  empty.connection.send('空正文');
  await tick();
  empty.transport.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
  await tick();
  assert.deepEqual(empty.events.filter((event) => event.type === 'error').map((event) => (
    event.type === 'error' ? event.diagnostic.code : ''
  )), ['CODEBUDDY_FINAL_ANSWER_MISSING']);

  const exited = createHarness();
  await initialize(exited);
  exited.connection.send('进程退出');
  await tick();
  exited.transport.fail(new Error('process exited'));
  assert.equal(exited.envelopes.filter((event) => event.payload.type === 'error'
    && event.meta.source === 'process_exit').length, 1);

  const duplicate = createHarness();
  await initialize(duplicate);
  duplicate.connection.send('重复响应');
  await tick();
  duplicate.transport.receive({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'cb-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '唯一回复' } },
  } });
  const response = { jsonrpc: '2.0' as const, id: 3, result: { stopReason: 'end_turn' } };
  duplicate.transport.receive(response);
  duplicate.transport.receive(response);
  await tick();
  assert.equal(duplicate.events.filter((event) => event.type === 'message_complete').length, 1);

  for (const harness of [business, empty, exited, duplicate]) harness.connection.close();
});

test('CodeBuddy 仅按明确容量 metadata 分类，普通业务失败保持 unknown', async () => {
  const rateLimited = createHarness();
  await initialize(rateLimited);
  rateLimited.connection.send('限流');
  await tick();
  rateLimited.transport.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn', _meta: {
    'codebuddy.ai/businessFailed': true,
    'codebuddy.ai/errorCode': 'RATE_LIMITED',
    'codebuddy.ai/retryAfterMs': 15_000,
  } } });
  await tick();
  const diagnostic = rateLimited.events.find((event) => event.type === 'error')?.diagnostic;
  assert.equal(diagnostic?.providerClass, 'rate_limit');
  assert.equal(diagnostic?.retryAfterMs, 15_000);

  const overloaded = createHarness();
  await initialize(overloaded);
  overloaded.connection.send('过载');
  await tick();
  overloaded.transport.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn', _meta: {
    'codebuddy.ai/outcome': 'PROVIDER_OVERLOADED',
  } } });
  await tick();
  assert.equal(overloaded.events.find((event) => event.type === 'error')?.diagnostic.providerClass, 'overloaded');

  for (const harness of [rateLimited, overloaded]) harness.connection.close();
});

test('CodeBuddy softFail 时把 codebuddy.ai/errorMessage 原文透传到 originalMessage', async () => {
  const quota = createHarness();
  await initialize(quota);
  quota.connection.send('触发额度拒绝');
  await tick();
  quota.transport.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn', _meta: {
    'codebuddy.ai/outcome': 'FAILED_MODEL_REQUEST',
    'codebuddy.ai/errorMessage': '429 额度已用尽，请访问以下链接，购买加量包以获取更多额度：https://www.codebuddy.cn/profile/usage',
    'codebuddy.ai/finishReason': 'tool_calls',
  } } });
  await tick();
  const diagnostic = quota.events.find((event) => event.type === 'error')?.diagnostic;
  assert.ok(diagnostic?.originalMessage, 'softFail 应携带 originalMessage');
  assert.match(diagnostic!.originalMessage!, /^429 额度已用尽/);
  assert.match(diagnostic!.originalMessage!, /FAILED_MODEL_REQUEST/);

  const noErrorMessage = createHarness();
  await initialize(noErrorMessage);
  noErrorMessage.connection.send('无错误原文的软失败');
  await tick();
  noErrorMessage.transport.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn', _meta: {
    'codebuddy.ai/outcome': 'PROVIDER_OVERLOADED',
    'codebuddy.ai/finishReason': 'stop',
  } } });
  await tick();
  const fallback = noErrorMessage.events.find((event) => event.type === 'error')?.diagnostic;
  assert.equal(fallback?.originalMessage, 'PROVIDER_OVERLOADED · stop');

  for (const harness of [quota, noErrorMessage]) harness.connection.close();
});

test('session/load 的历史 replay 不进入 Relay 事件，实时事件正常进入', async () => {
  const harness = createHarness('existing');
  harness.transport.open();
  await tick();
  harness.transport.receive({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
  await tick();
  harness.transport.receive({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'existing',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '旧消息' }, _meta: { 'codebuddy.ai': { mode: 'history' } } },
  } });
  harness.transport.receive({ jsonrpc: '2.0', id: 2, result: {} });
  await tick();
  assert.equal(harness.events.some((event) => event.type === 'delta'), false);
  harness.connection.send('继续');
  await tick();
  harness.transport.receive({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'existing', update: { sessionUpdate: 'agent_message_chunk', messageId: 'new', content: { type: 'text', text: '新消息' } },
  } });
  assert.equal(harness.events.some((event) => event.type === 'delta' && event.content === '新消息'), true);
  harness.connection.close();
});

test('工具、权限、取消和无正文映射为稳定公共事件', async () => {
  const harness = createHarness();
  await initialize(harness);
  harness.transport.receive({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'cb-session', update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Bash', status: 'in_progress', rawInput: { command: 'echo ok' } },
  } });
  harness.transport.receive({ jsonrpc: '2.0', id: 9, method: 'session/request_permission', params: {
    sessionId: 'cb-session', options: [{ kind: 'allow_once', optionId: 'yes' }], toolCall: { toolCallId: 'tool-1' },
  } });
  assert.equal(harness.events.some((event) => event.type === 'item_start'), true);
  assert.equal(harness.events.some((event) => event.type === 'server_request' && event.requestId === 9), true);
  harness.connection.respondToInteraction(9, { outcome: { outcome: 'selected', optionId: 'yes' } });
  assert.deepEqual(harness.transport.sent.at(-1), { jsonrpc: '2.0', id: 9, result: { outcome: { outcome: 'selected', optionId: 'yes' } } });
  harness.connection.send('取消');
  await tick();
  let cancelSettled = false;
  const cancelling = harness.connection.cancel().then(() => { cancelSettled = true; });
  await tick();
  assert.equal(harness.transport.sent.at(-1)?.method, 'session/cancel');
  assert.equal(cancelSettled, false);
  harness.transport.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } });
  await cancelling;
  assert.equal(cancelSettled, true);
  assert.equal(harness.events.some((event) => event.type === 'error' && event.diagnostic.code === 'CODEBUDDY_TURN_CANCELLED'), false);
  harness.connection.close();
});

test('取消未获 prompt 确认时保持等待，超时后强制回收 transport', async () => {
  const harness = createHarness(null, 1_000, { cancelConfirmationTimeoutMs: 20, promptIdleTimeoutMs: 1_000 });
  await initialize(harness);
  harness.connection.send('不会确认取消');
  await tick();

  await assert.rejects(harness.connection.cancel(),/CODEBUDDY_CANCEL_UNCONFIRMED/);

  assert.equal(harness.transport.sent.some((message) => message.method === 'session/cancel'), true);
  assert.equal(harness.transport.state, 'closed');
  assert.equal(harness.transport.terminateCount, 1);
  assert.deepEqual(harness.busyStates, [true, false]);
});

test('prompt 静默 watchdog 会被协议活动续期', async () => {
  const harness = createHarness(null, 1_000, { promptIdleTimeoutMs: 200 });
  await initialize(harness);
  harness.connection.send('持续活动');
  await new Promise((resolve) => setTimeout(resolve, 60));
  harness.transport.receive({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'cb-session', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '仍在处理' } },
  } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(harness.transport.state, 'open');
  assert.equal(harness.events.some((event) => event.type === 'error'), false);
  harness.transport.receive({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'cb-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成' } },
  } });
  harness.transport.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
  await tick();
  harness.connection.close();
});

test('prompt 长时间无协议活动时失败并回收 transport', async () => {
  const harness = createHarness(null, 1_000, { promptIdleTimeoutMs: 20 });
  await initialize(harness);
  harness.connection.send('永久无响应');
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(harness.events.some((event) => event.type === 'error' && event.diagnostic.code === 'CODEBUDDY_PROMPT_STALLED'), true);
  assert.equal(harness.transport.state, 'closed');
  assert.equal(harness.transport.terminateCount, 1);
  assert.deepEqual(harness.busyStates, [true, false]);
});

test('Agent Teams 事件进入子任务项且未知客户端请求被拒绝', async () => {
  const harness = createHarness();
  await initialize(harness);
  harness.transport.receive({ jsonrpc: '2.0', method: 'codebuddy.ai/memberEvent', params: { memberId: 'member-1', name: '研究员', status: 'running', summary: '处理中' } });
  assert.equal(harness.events.some((event) => event.type === 'item_start' && event.item.type === 'collabAgentToolCall'), true);
  harness.transport.receive({ jsonrpc: '2.0', id: 12, method: 'client/fs/read_text_file', params: { path: 'secret' } });
  assert.equal(harness.transport.sent.at(-1)?.error?.code, -32601);
  assert.equal(harness.events.some((event) => event.type === 'system_notice'), true);
  harness.connection.close();
});

test('config option updates ignore boolean values for model facts', async () => {
  const harness = createHarness();
  await initialize(harness);
  harness.transport.receive({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'cb-session',
    update: {
      sessionUpdate: 'config_option_update',
      configOptions: [
        { id: 'multitask', type: 'boolean', category: '_codebuddy.ai/multitask', currentValue: false },
        { id: 'thought_level', category: 'thought_level', currentValue: false },
      ],
    },
  } });
  assert.equal(harness.events.some((event) => event.type === 'model_info'), false);
  harness.connection.close();
});
