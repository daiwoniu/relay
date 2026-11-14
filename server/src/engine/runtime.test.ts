import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineConnection, EngineEvent } from './adapter.js';
import type { EngineEventEnvelope } from './events.js';
import {
  attachEngineConnection,
  clearPendingInteractionsForConnection,
  createSessionRuntimeState,
  disconnectEngineConnection,
  routeEngineEvent,
  shouldRetainSessionRuntime,
  prepareClaimedSessionRuntime,
  resolveTurnStartPreferences,
  updateTurnModelSnapshot,
  clearTurnModelSnapshot,
  completeRuntimeInteraction,
} from './runtime.js';

function fakeConnection(closed: string[]): EngineConnection {
  return {
    send: () => undefined,
    cancel: async () => undefined,
    respondToInteraction: () => undefined,
    close: () => { closed.push('closed'); },
  };
}

test('后台 runtime 不依赖浏览器订阅并继续接收引擎事件', () => {
  const runtime = createSessionRuntimeState({
    sessionId: 'session-1',
    projectId: 'project-1',
    engine: 'codebuddy',
  });
  runtime.isRunning = true;
  const closed: string[] = [];
  attachEngineConnection(runtime, fakeConnection(closed), 'connection-1');
  const received: EngineEventEnvelope[] = [];

  assert.equal(shouldRetainSessionRuntime(runtime, 0), true);
  const envelope: EngineEventEnvelope = { engineId: 'codebuddy', meta: { observedAt: 1, source: 'local', sequence: 1 }, payload: { type: 'request_forwarded' } };
  assert.equal(routeEngineEvent(runtime, 'connection-1', envelope, (event) => received.push(event)), true);
  assert.deepEqual(received, [envelope]);
  assert.deepEqual(closed, []);
});

test('interaction 完成记录决定来源并保持第一次终态', () => {
  const runtime = createSessionRuntimeState({ sessionId: 'session-1', projectId: 'project-1', engine: 'codex' });
  runtime.turnItems = [{ id: 'interaction:1', type: 'interaction', status: 'in_progress', details: { title: '运行命令' } }];
  const first = completeRuntimeInteraction(runtime, 'interaction:1', {
    resolvedAction: 'accept', source: 'session_trust', expiresAt: 9_000, decidedAt: 2_000,
  });
  assert.deepEqual(first?.details, {
    title: '运行命令', resolvedAction: 'accept', decisionSource: 'session_trust',
    effectiveScope: 'session', trustExpiresAt: 9_000, decidedAt: 2_000,
    decidedByDeviceId: null, decidedByDeviceType: null,
  });
  const repeated = completeRuntimeInteraction(runtime, 'interaction:1', {
    resolvedAction: 'decline', source: 'user', decidedAt: 3_000,
  });
  assert.equal(repeated, first);
  assert.equal((repeated?.details as Record<string, unknown>).decisionSource, 'session_trust');
});

test('人工和其他设备处理不伪造信任作用域', () => {
  for (const source of ['user', 'resolved_elsewhere'] as const) {
    const runtime = createSessionRuntimeState({ sessionId: 'session-1', projectId: null, engine: 'codex' });
    runtime.turnItems = [{ id: `interaction:${source}`, type: 'interaction', status: 'in_progress', details: {} }];
    const item = source === 'user'
      ? completeRuntimeInteraction(runtime, `interaction:${source}`, { resolvedAction: 'accept', source, decidedAt: 4_000 })
      : completeRuntimeInteraction(runtime, `interaction:${source}`, { resolvedAction: 'resolved_elsewhere', source, decidedAt: 4_000 });
    assert.equal((item?.details as Record<string, unknown>).effectiveScope, null);
    assert.equal((item?.details as Record<string, unknown>).trustExpiresAt, null);
  }
});

test('attempt 模型快照区分 requested/effective、识别 reroute 并可独立清除', () => {
  const runtime = createSessionRuntimeState({ sessionId: 'session-1', projectId: null, engine: 'codex' });
  prepareClaimedSessionRuntime(runtime, {
    projectId: null, attemptId: 'attempt-1', resourceKey: 'codex:default', leaseToken: 'lease-1', requestedByUserId: 'user-1', claimedAt: 1,
    preferences: { modelId: 'gpt-requested', reasoningEffort: 'high', serviceTier: 'priority' },
    displayNames: { 'gpt-requested': 'GPT Requested', 'gpt-effective': 'GPT Effective' },
  });
  updateTurnModelSnapshot(runtime, { type: 'model_info', model: 'gpt-effective', modelProvider: 'OpenAI', reasoningEffort: 'medium' });
  assert.deepEqual(runtime.turnModelSnapshot?.modelInfo, {
    engineId: 'codex',
    requested: { id: 'gpt-requested', displayName: 'GPT Requested', reasoningEffort: 'high' },
    effective: { id: 'gpt-effective', displayName: 'GPT Effective', provider: 'OpenAI', reasoningEffort: 'medium' },
    serviceTier: 'priority',
    resolvedServiceTier: 'priority',
    rerouted: true,
  });
  clearTurnModelSnapshot(runtime);
  assert.equal(runtime.turnModelSnapshot, null);
});

test('新 attempt 不继承连接级历史模型，等待本轮引擎事件确认', () => {
  const runtime = createSessionRuntimeState({ sessionId: 'session-1', projectId: null, engine: 'codex' });
  runtime.modelInfo = { type: 'model_info', model: 'gpt-previous', reasoningEffort: 'medium' };
  prepareClaimedSessionRuntime(runtime, {
    projectId: null, attemptId: 'attempt-1', resourceKey: 'codex:default', leaseToken: 'lease-1', requestedByUserId: 'user-1', claimedAt: 1,
    preferences: { modelId: null, reasoningEffort: null },
  });

  assert.equal(runtime.turnModelSnapshot?.modelInfo, null);
});

test('本轮默认配置在开轮时固定为具体强度与速度', () => {
  const runtime = createSessionRuntimeState({ sessionId: 'session-defaults', projectId: null, engine: 'codex' });
  prepareClaimedSessionRuntime(runtime, {
    projectId: null, attemptId: 'attempt-defaults', resourceKey: 'codex:default', leaseToken: 'lease-defaults', requestedByUserId: 'user-1', claimedAt: 1,
    preferences: { modelId: null, reasoningEffort: null, serviceTier: null },
    modelDefaults: { 'gpt-current': { reasoningEffort: 'high', serviceTier: 'priority' } },
    defaultModelId: 'gpt-current',
  });
  assert.deepEqual(resolveTurnStartPreferences(runtime), {
    modelId: 'gpt-current', reasoningEffort: 'high', serviceTier: 'priority',
  });
  updateTurnModelSnapshot(runtime, { type: 'model_info', model: 'gpt-current' });
  assert.equal(runtime.turnModelSnapshot?.modelInfo?.effective.reasoningEffort, 'high');
  assert.equal(runtime.turnModelSnapshot?.modelInfo?.resolvedServiceTier, 'priority');
  assert.equal(runtime.turnModelSnapshot?.modelInfo?.serviceTier, null);
});

test('本轮显式选择覆盖目录默认档位', () => {
  const runtime = createSessionRuntimeState({ sessionId: 'session-explicit', projectId: null, engine: 'codex' });
  prepareClaimedSessionRuntime(runtime, {
    projectId: null, attemptId: 'attempt-explicit', resourceKey: 'codex:default', leaseToken: 'lease-explicit', requestedByUserId: 'user-1', claimedAt: 1,
    preferences: { modelId: 'gpt-current', reasoningEffort: 'medium', serviceTier: 'default' },
    modelDefaults: { 'gpt-current': { reasoningEffort: 'high', serviceTier: 'priority' } },
    defaultModelId: 'gpt-current',
  });
  assert.deepEqual(resolveTurnStartPreferences(runtime), {
    modelId: 'gpt-current', reasoningEffort: 'medium', serviceTier: 'default',
  });
});

test('模型不提供速度档位时本轮快照明确记录不可用', () => {
  const runtime = createSessionRuntimeState({ sessionId: 'session-no-tier', projectId: null, engine: 'codex' });
  prepareClaimedSessionRuntime(runtime, {
    projectId: null, attemptId: 'attempt-no-tier', resourceKey: 'codex:default', leaseToken: 'lease-no-tier', requestedByUserId: 'user-1', claimedAt: 1,
    preferences: { modelId: 'gpt-no-tier', reasoningEffort: null, serviceTier: null },
    modelDefaults: { 'gpt-no-tier': { reasoningEffort: 'medium', serviceTier: null } },
  });
  updateTurnModelSnapshot(runtime, { type: 'model_info', model: 'gpt-no-tier' });
  assert.equal(resolveTurnStartPreferences(runtime).serviceTier, null);
  assert.equal(runtime.turnModelSnapshot?.modelInfo?.resolvedServiceTier, null);
});

test('runtime 忽略旧连接事件并通过统一 connection 完成清理', () => {
  const runtime = createSessionRuntimeState({ sessionId: 'session-1', projectId: null, engine: 'codex' });
  const closed: string[] = [];
  attachEngineConnection(runtime, fakeConnection(closed), 'current');
  const received: EngineEventEnvelope[] = [];

  assert.equal(routeEngineEvent(runtime, 'stale', { engineId: 'codex', meta: { observedAt: 1, source: 'local', sequence: 1 }, payload: { type: 'request_forwarded' } }, (event) => received.push(event)), false);
  disconnectEngineConnection(runtime);

  assert.deepEqual(received, []);
  assert.deepEqual(closed, ['closed']);
  assert.equal(runtime.engineConnection, null);
  assert.equal(runtime.engineConnectionId, null);
});

test('runtime 只接收当前引擎的标准事件信封', () => {
  const runtime = createSessionRuntimeState({ sessionId: 'session-1', projectId: null, engine: 'codex' });
  attachEngineConnection(runtime, fakeConnection([]), 'current');
  const received: EngineEventEnvelope[] = [];
  const envelope = {
    engineId: 'codex',
    meta: { observedAt: 1, source: 'local', sequence: 1 },
    payload: { type: 'request_forwarded' },
  };

  assert.equal(routeEngineEvent(runtime, 'current', envelope as any, (event) => received.push(event)), true);
  assert.deepEqual(received, [envelope]);

  assert.equal(routeEngineEvent(runtime, 'current', { ...envelope, engineId: 'codebuddy' } as any, () => undefined), false);
});

test('只读 observer 在 handler 前观察信封且失败不影响主链路', () => {
  const calls: string[] = [];
  const runtime = createSessionRuntimeState({
    sessionId: 'session-1', projectId: null, engine: 'codex',
    observeEngineEvent: (event) => { calls.push(`observe:${event.meta.sequence}`); throw new Error('observer failed'); },
  });
  attachEngineConnection(runtime, fakeConnection([]), 'current');
  const envelope: EngineEventEnvelope = {
    engineId: 'codex', meta: { observedAt: 1, source: 'realtime', sequence: 3 }, payload: { type: 'turn_complete', turnId: 'turn-1' },
  };

  assert.equal(routeEngineEvent(runtime, 'current', envelope, () => calls.push('handle')), true);
  assert.deepEqual(calls, ['observe:3', 'handle']);
});

test('事实 sink 只在连接和引擎门禁通过后执行且失败不影响 handler', () => {
  const calls: string[] = [];
  const observedAttempts: string[] = [];
  const runtime = createSessionRuntimeState({
    sessionId: 'session-1', projectId: null, engine: 'codex',
    turnFactSink: {
      record: (_event, context) => {
        calls.push('sink');
        observedAttempts.push(context.attemptId);
        throw new Error('sink failed');
      },
      recordInterruptConfirmed: () => null,
      recordConnectionClosed: () => null,
      recordEngineError: () => null,
      recordRecoveryFailed: () => null,
      recordRecoveryInterrupted: () => null,
    },
  });
  runtime.attemptId = 'attempt-1';
  attachEngineConnection(runtime, fakeConnection([]), 'current');
  const envelope: EngineEventEnvelope = {
    engineId: 'codex', meta: { observedAt: 1, source: 'realtime', sequence: 1 }, payload: { type: 'turn_start', turnId: 'turn-1' },
  };
  assert.equal(routeEngineEvent(runtime, 'current', envelope, (event) => {
    calls.push('handle');
    if (event.payload.type === 'turn_start') runtime.currentTurnId = event.payload.turnId;
  }), true);
  assert.deepEqual(calls, ['sink', 'handle']);
  assert.deepEqual(observedAttempts, ['attempt-1']);
  assert.equal(runtime.currentTurnId, 'turn-1');
  assert.equal(runtime.attemptId, 'attempt-1');
  calls.length = 0;
  assert.equal(routeEngineEvent(runtime, 'stale', envelope, () => calls.push('handle')), false);
  assert.deepEqual(calls, []);
});

test('断开引擎连接时只清理归属该连接的待处理授权', () => {
  const runtime = createSessionRuntimeState({ sessionId: 'session-1', projectId: null, engine: 'codex' });
  const entry = (connectionId: string | null) => ({
    request: { requestId: 1, method: 'execCommandApproval', params: {} },
    interaction: {} as never,
    standalone: false,
    createdAt: 1,
    connectionId,
  });
  runtime.pendingInteractions.set('interaction:conn-a:0', entry('conn-a'));
  runtime.pendingInteractions.set('interaction:conn-a:1', entry('conn-a'));
  runtime.pendingInteractions.set('interaction:conn-b:0', entry('conn-b'));

  assert.deepEqual(clearPendingInteractionsForConnection(runtime, 'conn-a').sort(), ['interaction:conn-a:0', 'interaction:conn-a:1']);
  assert.equal(runtime.pendingInteractions.size, 1);
  assert.equal(runtime.pendingInteractions.has('interaction:conn-b:0'), true);
  // 没有连接标识时不清理，避免误伤仍可处理的请求
  assert.deepEqual(clearPendingInteractionsForConnection(runtime, null), []);
});

test('用户处理授权时记录处理设备标识与设备类型', () => {
  const runtime = createSessionRuntimeState({ sessionId: 'session-1', projectId: null, engine: 'codex' });
  runtime.turnItems = [{ id: 'interaction:device', type: 'interaction', status: 'in_progress', details: {} }];
  const item = completeRuntimeInteraction(runtime, 'interaction:device', {
    resolvedAction: 'accept', source: 'user', decidedAt: 5_000,
    decidedByDeviceId: 'device-a', decidedByDeviceType: 'desktop',
  });
  const details = item?.details as Record<string, unknown>;
  assert.equal(details.decidedByDeviceId, 'device-a');
  assert.equal(details.decidedByDeviceType, 'desktop');

  // 未提供设备标识时归为 null，不影响既有结算语义
  const plain = createSessionRuntimeState({ sessionId: 'session-2', projectId: null, engine: 'codex' });
  plain.turnItems = [{ id: 'interaction:plain', type: 'interaction', status: 'in_progress', details: {} }];
  const plainItem = completeRuntimeInteraction(plain, 'interaction:plain', { resolvedAction: 'decline', source: 'user', decidedAt: 6_000 });
  assert.equal((plainItem?.details as Record<string, unknown>).decidedByDeviceId, null);
});
