import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineInteractionAdapter } from '../engine/facets.js';
import { defineNormalizedInteraction } from '../engine/interactions.js';
import { attachEngineConnection, createSessionRuntimeState } from '../engine/runtime.js';
import type { EffectiveApprovalTrust } from '../services/approval-trust.js';
import { routeIncomingApproval } from './frontend-approval-routing.js';

const request = { requestId: 1, method: 'approval', params: {} };
const adapter: EngineInteractionAdapter = {
  normalize: (value) => defineNormalizedInteraction({ requestId: value.requestId, kind: 'command', snapshot: { title: '运行命令' }, availableActions: ['accept_once', 'decline'] }),
  buildResponse: (_value, command) => ({ action: command.action }),
};
const trusted: EffectiveApprovalTrust = {
  trusted: true, source: 'session_trust', effectiveScope: 'session', expiresAt: 9_000,
  sessionOverridesProject: false, diagnostic: null,
};
/** 多数用例不关心 owner 兜底：模拟请求人即会话所有人。 */
const ownerIsRequester = { resolveSessionOwnerUserId: () => 'requester-1' };
function runtime(respond: (requestId: string | number, result: unknown) => void) {
  const value = createSessionRuntimeState({ sessionId: 'session-1', projectId: 'project-1', engine: 'codex' });
  value.requestedByUserId = 'requester-1';
  attachEngineConnection(value, { send: () => undefined, cancel: async () => undefined, respondToInteraction: respond, close: () => undefined }, 'connection-1');
  return value;
}

test('活动 attempt 不因临时 isRunning 状态被误判为独立审批', () => {
  const currentRuntime = runtime(() => undefined);
  currentRuntime.attemptId = 'active-attempt';
  const result = routeIncomingApproval({ runtime: currentRuntime, adapter, request,
    resolveTrust: () => trusted, ...ownerIsRequester });
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.outcome === 'accepted' && result.standalone, false);
});

test('请求到达时只读取一次信任并只发送一次 accept_once', () => {
  let reads = 0;
  const responses: unknown[] = [];
  const currentRuntime = runtime((requestId, result) => responses.push({ requestId, result }));
  const routed = routeIncomingApproval({
    runtime: currentRuntime, adapter, request,
    resolveTrust: (ownerUserId, sessionId) => {
      reads += 1;
      assert.equal(ownerUserId, 'requester-1');
      assert.equal(sessionId, 'session-1');
      return trusted;
    },
    clock: () => 2_000,
    ...ownerIsRequester,
  });
  assert.equal(reads, 1);
  assert.equal(routed.outcome, 'accepted');
  assert.deepEqual(responses, [{ requestId: 1, result: { action: 'accept_once' } }]);
  assert.deepEqual(routed.outcome === 'accepted' ? routed.item.details : null, {
    interactionKind: 'command_approval', requestId: 1, method: 'approval', title: '运行命令',
    resolvedAction: 'accept', decisionSource: 'session_trust', effectiveScope: 'session',
    trustExpiresAt: 9_000, decidedAt: 2_000, decidedByDeviceId: null, decidedByDeviceType: null,
  });
  assert.equal(currentRuntime.pendingInteractions.size, 0);
  assert.equal(routeIncomingApproval({ runtime: currentRuntime, adapter, request, resolveTrust: () => trusted, ...ownerIsRequester }).outcome, 'duplicate');
  assert.equal(reads, 1);
  assert.equal(responses.length, 1);
});

test('缺少实际请求账号时回落会话所有人读取信任， owner 也缺失才保持人工', () => {
  const currentRuntime = runtime(() => undefined);
  currentRuntime.requestedByUserId = null;
  let reads = 0;
  const routed = routeIncomingApproval({
    runtime: currentRuntime,
    adapter,
    request,
    resolveTrust: () => { reads += 1; return trusted; },
    resolveSessionOwnerUserId: (sessionId) => {
      assert.equal(sessionId, 'session-1');
      return 'session-owner-1';
    },
  });
  assert.equal(routed.outcome, 'accepted');
  assert.equal(reads, 1);
  // owner 也查不到时才安全回落人工
  const fallbackRuntime = runtime(() => undefined);
  fallbackRuntime.requestedByUserId = null;
  let ownerReads = 0;
  const fallbackRouted = routeIncomingApproval({
    runtime: fallbackRuntime,
    adapter,
    request: { ...request, requestId: 3 },
    resolveTrust: () => { reads += 1; return trusted; },
    resolveSessionOwnerUserId: () => { ownerReads += 1; return null; },
  });
  assert.equal(fallbackRouted.outcome, 'manual');
  assert.equal(ownerReads, 1);
});

test('信任读取、标准化、构造和响应异常全部回落人工', () => {
  const cases: Array<Parameters<typeof routeIncomingApproval>[0]> = [
    { runtime: runtime(() => undefined), adapter, request, resolveTrust: () => { throw new Error('read'); }, ...ownerIsRequester },
    { runtime: runtime(() => undefined), adapter: { ...adapter, buildResponse: () => { throw new Error('build'); } }, request, resolveTrust: () => trusted, ...ownerIsRequester },
    { runtime: runtime(() => { throw new Error('respond'); }), adapter, request, resolveTrust: () => trusted, ...ownerIsRequester },
    { runtime: createSessionRuntimeState({ sessionId: 's', projectId: null, engine: 'codex' }), adapter, request, resolveTrust: () => trusted, ...ownerIsRequester },
  ];
  for (const input of cases) {
    assert.equal(routeIncomingApproval(input).outcome, 'manual');
    assert.equal(input.runtime.pendingInteractions.size, 1);
  }
});

test('unknown 标准交互即使有信任也保持人工', () => {
  const unknown = defineNormalizedInteraction({ requestId: 2, kind: 'unknown', snapshot: { title: '未知请求' }, availableActions: [] });
  const unknownAdapter = { ...adapter, normalize: () => unknown };
  assert.equal(routeIncomingApproval({
    runtime: runtime(() => undefined), adapter: unknownAdapter, request: { ...request, requestId: 2 },
    resolveTrust: () => trusted,
    ...ownerIsRequester,
  }).outcome, 'manual');
});

test('已冻结为人工的请求不会因后续设置变化而追溯自动响应', () => {
  let manual = true;
  const responses: unknown[] = [];
  const currentRuntime = runtime((requestId, result) => responses.push({ requestId, result }));
  assert.equal(routeIncomingApproval({
    runtime: currentRuntime, adapter, request,
    resolveTrust: () => manual
      ? { ...trusted, trusted: false, source: 'manual', effectiveScope: null }
      : trusted,
    ...ownerIsRequester,
  }).outcome, 'manual');
  manual = false;
  assert.equal(currentRuntime.pendingInteractions.size, 1);
  assert.deepEqual(responses, []);
});
