import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAdapter, codexEventSource, codexHandshakeMilestone, toEngineEvent } from './adapter.js';
import type { EngineModelCatalog } from '../engine/models/types.js';

test('Codex Relay 消息显式映射为公共事件且忽略非运行事件', () => {
  assert.deepEqual(toEngineEvent({ type: 'request_forwarded' }), { type: 'request_forwarded' });
  assert.deepEqual(toEngineEvent({ type: 'turn_start', turnId: 'turn-1' }), { type: 'turn_start', turnId: 'turn-1' });
  assert.equal(toEngineEvent({ type: 'sync', sessions: [], messages: [] }), null);
});

test('Codex 恢复、本地转发与实时事件来源诚实区分', () => {
  const recovery = toEngineEvent({
    type: 'recovery_snapshot', turnId: 'turn-1', status: 'inProgress', content: '', items: [], waitingOnInteraction: false,
  })!;
  assert.equal(codexEventSource(recovery), 'recovery');
  assert.equal(codexEventSource({ type: 'request_forwarded' }), 'local');
  assert.equal(codexEventSource({ type: 'turn_complete', turnId: 'turn-1' }), 'realtime');
});

test('Codex 恢复与传输错误按诊断阶段标记来源', () => {
  const recoveryError = toEngineEvent({ type: 'error', code: 'RESTART_RECOVERY_FAILED', message: 'failed' })!;
  const connectionError = toEngineEvent({ type: 'error', code: 'CODEX_CONNECTION_ERROR', message: 'failed' })!;
  assert.equal(codexEventSource(recoveryError), 'recovery');
  assert.equal(codexEventSource(connectionError), 'process_exit');
});

test('Codex 实时与恢复终态保持足够事实供统一仲裁', () => {
  assert.deepEqual(toEngineEvent({
    type: 'message_complete', turnId: 'turn-1', content: '最终回复', processContent: '过程',
  }), {
    type: 'message_complete', turnId: 'turn-1', content: '最终回复', processContent: '过程',
  });
  assert.deepEqual(toEngineEvent({
    type: 'recovery_snapshot', turnId: 'turn-1', status: 'completed', content: '恢复回复',
    items: [], waitingOnInteraction: false,
  }), {
    type: 'recovery_snapshot', turnId: 'turn-1', status: 'completed', content: '恢复回复',
    items: [], waitingOnInteraction: false,
  });
  const error = toEngineEvent({ type: 'error', code: 'CODEX_PROVIDER_ERROR', message: '失败' });
  assert.ok(error);
  assert.equal(error.type, 'error');
  if (error.type !== 'error') return;
  assert.equal(error.diagnostic.code, 'CODEX_PROVIDER_ERROR');
  assert.equal(error.diagnostic.phase, 'provider');
});

test('Codex Adapter 通过 models 分面获取动态目录', async () => {
  const expected: EngineModelCatalog = { engineId: 'codex', fetchedAt: 1, stale: false, models: [] };
  const adapter = new CodexAdapter({ listModels: async () => expected });
  assert.deepEqual(await adapter.models.listModels(), expected);
});

test('Codex Adapter 只把成功握手阶段映射为性能里程碑', () => {
  assert.equal(codexHandshakeMilestone({ stage: 'connection', outcome: 'completed', durationMs: 1 }), 'transport_opened');
  assert.equal(codexHandshakeMilestone({ stage: 'initialize', outcome: 'completed', durationMs: 1 }), 'protocol_initialized');
  assert.equal(codexHandshakeMilestone({ stage: 'config/get', outcome: 'completed', durationMs: 1 }), 'configuration_ready');
  assert.equal(codexHandshakeMilestone({ stage: 'thread/resume', outcome: 'completed', durationMs: 1 }), null);
  assert.equal(codexHandshakeMilestone({ stage: 'initialize', outcome: 'failed', durationMs: 1 }), null);
});

test('Codex interactions 分面标准化命令、文件和权限授权', () => {
  const interactions = new CodexAdapter().interactions;
  const fixtures = [
    ['item/commandExecution/requestApproval', 'command', { command: 'npm test', cwd: 'G:/AI/relay', availableDecisions: ['accept', 'acceptForSession', 'decline'] }],
    ['item/fileChange/requestApproval', 'file', { fileChanges: [{ path: 'a.ts', kind: 'update' }] }],
    ['item/permissions/requestApproval', 'permissions', { permissions: { network: true, token: 'secret' } }],
    ['execCommandApproval', 'command', { command: 'git status' }],
    ['applyPatchApproval', 'file', { grantRoot: 'G:/AI/relay' }],
  ] as const;

  for (const [method, kind, params] of fixtures) {
    const normalized = interactions.normalize({ requestId: method, method, params });
    assert.equal(normalized.kind, kind);
    assert.equal(normalized.autoApprovable, true);
    assert.equal(normalized.availableActions.includes('accept_once'), true);
    assert.doesNotMatch(JSON.stringify(normalized.snapshot), /"token"|secret/);
  }
});

test('Codex interactions 分面保持用户输入、MCP 和 unknown 为人工', () => {
  const interactions = new CodexAdapter().interactions;
  const userInput = interactions.normalize({
    requestId: 1,
    method: 'item/tool/requestUserInput',
    params: { questions: [{ id: 'q1', question: '继续吗？' }] },
  });
  const mcp = interactions.normalize({
    requestId: 2,
    method: 'mcpServer/elicitation/request',
    params: { serverName: 'example', requestedSchema: { type: 'object' } },
  });
  const unknown = interactions.normalize({ requestId: 3, method: 'future/request', params: { token: 'secret' } });

  assert.deepEqual([userInput.kind, mcp.kind, unknown.kind], ['user_input', 'mcp_elicitation', 'unknown']);
  assert.deepEqual(userInput.availableActions, ['submit', 'cancel']);
  assert.deepEqual(mcp.availableActions, ['submit', 'decline', 'cancel']);
  assert.equal(userInput.autoApprovable || mcp.autoApprovable || unknown.autoApprovable, false);
  assert.deepEqual(unknown.snapshot, { title: '需要处理客户端请求' });
});

test('Codex interactions 分面只构造当前请求支持的协议响应', () => {
  const interactions = new CodexAdapter().interactions;
  const command = { requestId: 1, method: 'item/commandExecution/requestApproval', params: { availableDecisions: ['accept', 'decline'] } };
  assert.deepEqual(interactions.buildResponse(command, { action: 'accept_once' }), { decision: 'accept' });
  assert.deepEqual(interactions.buildResponse(command, { action: 'decline' }), { decision: 'decline' });
  assert.throws(() => interactions.buildResponse(command, { action: 'accept_for_session' }), /不可用/);
  assert.throws(() => interactions.buildResponse(command, { action: 'submit' }), /不可用/);
  assert.throws(() => interactions.buildResponse({ requestId: 2, method: 'item/fileChange/requestApproval', params: { availableDecisions: ['accept'] } }, { action: 'decline' }), /不可用/);

  assert.deepEqual(interactions.buildResponse({ requestId: 2, method: 'item/fileChange/requestApproval', params: {} }, { action: 'cancel' }), { decision: 'cancel' });
  assert.deepEqual(interactions.buildResponse({ requestId: 3, method: 'execCommandApproval', params: {} }, { action: 'accept_once' }), { decision: 'approved' });
  assert.deepEqual(interactions.buildResponse({ requestId: 4, method: 'item/permissions/requestApproval', params: { permissions: { network: true, filesystem: null } } }, { action: 'accept_once' }), { permissions: { network: true }, scope: 'turn' });
  assert.deepEqual(interactions.buildResponse({ requestId: 5, method: 'item/tool/requestUserInput', params: {} }, { action: 'submit', answers: { q1: ['yes'] } }), { answers: { q1: { answers: ['yes'] } } });
  assert.deepEqual(interactions.buildResponse({ requestId: 6, method: 'mcpServer/elicitation/request', params: {} }, { action: 'submit', formData: { name: 'Relay' } }), { action: 'accept', content: { name: 'Relay' }, _meta: null });
  assert.throws(() => interactions.buildResponse({ requestId: 7, method: 'future/request', params: {} }, { action: 'cancel' }), /暂不支持/);
});
