import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLauncherControlResponse,
  createLauncherEngineControlResponse,
  createLauncherMaintenanceOutputResponse,
  createLauncherStatusResponse,
  createLauncherRuntimeStatusResponse,
  createLauncherSetupResponse,
  createLauncherSetupStatusResponse,
  parseLauncherControlCommit,
  parseLauncherControlMessage,
  parseLauncherControlResponse,
  parseLauncherEngineControlAbort,
  parseLauncherEngineControlCommit,
  parseLauncherEngineControlMessage,
  parseLauncherEngineControlResponse,
  parseLauncherMaintenanceOutputRequest,
  parseLauncherMaintenanceOutputResponse,
  parseLauncherStatusRequest,
  parseLauncherStatusResponse,
  parseLauncherRuntimeStatusRequest,
  parseLauncherRuntimeStatusResponse,
  parseLauncherSetupControlCommit,
  parseLauncherSetupControlMessage,
  parseLauncherSetupResponse,
  parseLauncherSetupStatusRequest,
  parseLauncherSetupStatusResponse,
} from './lib/launcher-control.mjs';

const validMessage = {
  channel: 'relay-control-v1',
  type: 'restart_request',
  operationId: 'op-1',
  target: 'backend',
  requestedBy: 'admin',
  clientProtocolVersion: 11,
  serverProtocolVersion: 10,
};

test('解析器只接受 relay-control-v1 白名单重启请求', () => {
  assert.deepEqual(parseLauncherControlMessage(validMessage), validMessage);
  assert.equal(parseLauncherControlMessage({ ...validMessage, target: 'frontend' })?.target, 'frontend');
  assert.equal(parseLauncherControlMessage({ ...validMessage, target: 'relay' })?.target, 'relay');
  assert.equal(parseLauncherControlMessage({ ...validMessage, target: 'codex' }), null);
  assert.equal(parseLauncherControlMessage({ ...validMessage, target: 'codex_upgrade' }), null);
  assert.equal(parseLauncherControlMessage({ ...validMessage, target: 'setup' }), null);
});

test('运行状态查询只接受固定字段且不允许携带命令或路径', () => {
  const request = { channel: 'relay-control-v1', type: 'runtime_status_request', requestId: 'runtime-1' };
  assert.deepEqual(parseLauncherRuntimeStatusRequest(request), request);
  assert.equal(parseLauncherRuntimeStatusRequest({ ...request, command: 'build' }), null);
  const response = createLauncherRuntimeStatusResponse(request, {
    frontendMode: 'production',
    activeBuildId: 'abcdef123456',
    activeBuildLabel: '20260809-1410 · abcdef1',
    frontendBuildRequired: true,
    frontendBuildReason: '前端源码较活动构建更新',
  });
  assert.deepEqual(parseLauncherRuntimeStatusResponse(response), response);
  assert.equal(parseLauncherRuntimeStatusResponse({ ...response, path: 'G:\\secret' }), null);
  assert.equal(parseLauncherRuntimeStatusResponse({ ...response, activeBuildId: '../bad' }), null);
  assert.equal(parseLauncherRuntimeStatusResponse({ ...response, activeBuildLabel: '2026-08-09 abcdef1' }), null);
  assert.equal(parseLauncherRuntimeStatusResponse({ ...response, frontendMode: 'development', activeBuildId: null, activeBuildLabel: '20260809-1410 · abcdef1', frontendBuildRequired: false, frontendBuildReason: null }), null);
});

test('拒绝未知通道、消息类型、目标和缺失 operationId', () => {
  assert.equal(parseLauncherControlMessage({ ...validMessage, channel: 'other' }), null);
  assert.equal(parseLauncherControlMessage({ ...validMessage, type: 'run_command' }), null);
  assert.equal(parseLauncherControlMessage({ ...validMessage, target: 'shell' }), null);
  assert.equal(parseLauncherControlMessage({ ...validMessage, operationId: '' }), null);
});

test('拒绝命令、PID、路径和其他白名单外字段', () => {
  for (const extra of [
    { command: 'npm run restart' },
    { pid: 1234 },
    { path: 'G:\\secret' },
    { token: 'secret' },
  ]) {
    assert.equal(parseLauncherControlMessage({ ...validMessage, ...extra }), null);
  }
});

test('拒绝无效操作者和协议版本', () => {
  assert.equal(parseLauncherControlMessage({ ...validMessage, requestedBy: '' }), null);
  assert.equal(parseLauncherControlMessage({ ...validMessage, requestedBy: 'admin\n伪造日志' }), null);
  assert.equal(parseLauncherControlMessage({ ...validMessage, clientProtocolVersion: -1 }), null);
  assert.equal(parseLauncherControlMessage({ ...validMessage, clientProtocolVersion: 1_000_001 }), null);
  assert.equal(parseLauncherControlMessage({ ...validMessage, serverProtocolVersion: 1.5 }), null);
});

test('恢复回执使用固定白名单结构并拒绝额外字段', () => {
  const accepted = createLauncherControlResponse(validMessage, 'accepted');
  assert.deepEqual(parseLauncherControlResponse(accepted), {
    channel: 'relay-control-v1',
    type: 'restart_response',
    operationId: 'op-1',
    target: 'backend',
    status: 'accepted',
    reason: null,
    retryAfterMs: 0,
    message: null,
  });
  const rejected = createLauncherControlResponse(validMessage, 'rejected', 'rate_limited', 30_000);
  assert.equal(parseLauncherControlResponse(rejected)?.retryAfterMs, 30_000);
  assert.equal(parseLauncherControlResponse({ ...accepted, command: 'restart' }), null);
  assert.equal(parseLauncherControlResponse({ ...accepted, status: 'unknown' }), null);
  const failed = createLauncherControlResponse(validMessage, 'failed', null, 0, '完整重启已取消，现有服务仍在运行');
  assert.equal(parseLauncherControlResponse(failed)?.message, '完整重启已取消，现有服务仍在运行');
  assert.equal(parseLauncherControlResponse({ ...failed, message: '伪造\n日志' }), null);
});

test('恢复确认只接受 operationId 与目标固定结构', () => {
  const commit = { channel: 'relay-control-v1', type: 'restart_commit', operationId: 'op-1', target: 'backend' };
  assert.deepEqual(parseLauncherControlCommit(commit), commit);
  assert.equal(parseLauncherControlCommit({ ...commit, target: 'relay' })?.target, 'relay');
  assert.equal(parseLauncherControlCommit({ ...commit, target: 'codex' }), null);
  assert.equal(parseLauncherControlCommit({ ...commit, target: 'shell' }), null);
  assert.equal(parseLauncherControlCommit({ ...commit, command: 'restart' }), null);
});

test('状态查询只接受固定 requestId 并仅返回前后端状态', () => {
  const request = { channel: 'relay-control-v1', type: 'status_request', requestId: 'status-1' };
  assert.deepEqual(parseLauncherStatusRequest(request), request);
  assert.equal(parseLauncherStatusRequest({ ...request, command: 'npm run setup' }), null);
  const response = createLauncherStatusResponse(request, {
    backendRetryAfterMs: 30_000,
    frontendRetryAfterMs: 10_000,
    operationInProgress: true,
  });
  assert.deepEqual(parseLauncherStatusResponse(response), response);
  assert.equal(parseLauncherStatusResponse({ ...response, backendRetryAfterMs: -1 }), null);
  assert.equal(parseLauncherStatusResponse({ ...response, operationInProgress: 'yes' }), null);
  assert.equal(parseLauncherStatusResponse({ ...response, codexVersion: '0.146.0' }), null);
});

test('维护输出查询严格绑定 operationId 并限制为最近两行安全文本', () => {
  const request = { channel: 'relay-maintenance-output-v1', type: 'output_status_request', requestId: 'output-1', operationId: 'op-1' };
  assert.deepEqual(parseLauncherMaintenanceOutputRequest(request), request);
  assert.equal(parseLauncherMaintenanceOutputRequest({ ...request, command: 'npm run restart' }), null);
  assert.equal(parseLauncherMaintenanceOutputRequest({ ...request, operationId: '../other' }), null);

  const output = { operationId: 'op-1', sequence: 3, lines: ['第一行', '第二行'], status: 'running', updatedAt: 100 };
  const response = createLauncherMaintenanceOutputResponse(request, output);
  assert.deepEqual(parseLauncherMaintenanceOutputResponse(response), response);
  assert.equal(parseLauncherMaintenanceOutputResponse({ ...response, path: 'G:\\secret' }), null);
  assert.equal(parseLauncherMaintenanceOutputResponse({ ...response, output: { ...output, operationId: 'other' } }), null);
  assert.equal(parseLauncherMaintenanceOutputResponse({ ...response, output: { ...output, lines: ['1', '2', '3'] } }), null);
  assert.equal(parseLauncherMaintenanceOutputResponse({ ...response, output: { ...output, lines: ['伪造\n日志'] } }), null);
  assert.equal(parseLauncherMaintenanceOutputResponse({ ...response, output: { ...output, lines: ['x'.repeat(501)] } }), null);
  assert.equal(parseLauncherMaintenanceOutputResponse({ ...response, output: { ...output, sequence: -1 } }), null);
  assert.equal(parseLauncherMaintenanceOutputResponse({ ...response, output: { ...output, status: 'unknown' } }), null);
  assert.deepEqual(parseLauncherMaintenanceOutputResponse(createLauncherMaintenanceOutputResponse(request, null)), createLauncherMaintenanceOutputResponse(request, null));
});

test('relay-engine-control-v1 只接受固定引擎动作组合', () => {
  const request = {
    channel: 'relay-engine-control-v1', type: 'engine_request', operationId: 'engine-1',
    engineId: 'codex', action: 'upgrade_and_restart', requestedBy: 'admin', workspaceRoots: ['G:\\AI\\Codex\\xinshu'],
  };
  assert.deepEqual(parseLauncherEngineControlMessage(request), request);
  assert.equal(parseLauncherEngineControlMessage({ ...request, action: 'upgrade' }), null);
  assert.equal(parseLauncherEngineControlMessage({ ...request, engineId: 'codebuddy', action: 'restart' }), null);
  assert.deepEqual(parseLauncherEngineControlMessage({ ...request, engineId: 'codebuddy', action: 'recheck' }), { ...request, engineId: 'codebuddy', action: 'recheck' });
  assert.equal(parseLauncherEngineControlMessage({ ...request, packageName: '@openai/codex' }), null);
  assert.equal(parseLauncherEngineControlMessage({ ...request, workspaceRoots: ['relative'] }), null);
  assert.equal(parseLauncherEngineControlMessage({ ...request, workspaceRoots: Array(33).fill('G:\\AI\\Codex\\xinshu') }), null);
  const commit = { channel: 'relay-engine-control-v1', type: 'engine_commit', operationId: 'engine-1', engineId: 'codex', action: 'upgrade_and_restart' };
  assert.deepEqual(parseLauncherEngineControlCommit(commit), commit);
  const abort = { channel: 'relay-engine-control-v1', type: 'engine_abort', operationId: 'engine-1', engineId: 'codex', action: 'upgrade_and_restart' };
  assert.deepEqual(parseLauncherEngineControlAbort(abort), abort);
  assert.equal(parseLauncherEngineControlAbort({ ...abort, type: 'engine_commit' }), null);
  assert.equal(parseLauncherEngineControlAbort({ ...abort, requestedBy: 'admin' }), null);
  assert.deepEqual(parseLauncherEngineControlAbort({ ...abort, engineId: 'codebuddy', action: 'recheck' }), { channel: 'relay-engine-control-v1', type: 'engine_abort', operationId: 'engine-1', engineId: 'codebuddy', action: 'recheck' });
  const unknownRejection = createLauncherEngineControlResponse(abort, 'rejected', 'operation_unknown');
  assert.deepEqual(parseLauncherEngineControlResponse(unknownRejection), unknownRejection);
  const response = createLauncherEngineControlResponse(request, 'rejected', 'rate_limited', 10_000);
  assert.deepEqual(parseLauncherEngineControlResponse(response), response);
  const failed = createLauncherEngineControlResponse(request, 'failed', 'upgrade_failed');
  assert.deepEqual(parseLauncherEngineControlResponse(failed), failed);
  const quotaDeferred = createLauncherEngineControlResponse({ ...request, engineId: 'codebuddy', action: 'upgrade', workspaceRoots: [] }, 'failed', 'quota_deferred');
  assert.deepEqual(parseLauncherEngineControlResponse(quotaDeferred), quotaDeferred);
  assert.equal(parseLauncherEngineControlResponse({ ...failed, reason: null }), null);
  assert.equal(parseLauncherEngineControlResponse({ ...response, registry: 'https://example.com' }), null);
});

test('relay-setup-control-v1 只接受固定 setup 事务且拒绝命令参数', () => {
  const request = { channel: 'relay-setup-control-v1', type: 'setup_request', operationId: 'setup-1', requestedBy: 'admin' };
  assert.deepEqual(parseLauncherSetupControlMessage(request), request);
  assert.equal(parseLauncherSetupControlMessage({ ...request, command: 'npm run setup' }), null);
  assert.equal(parseLauncherSetupControlMessage({ ...request, registry: 'https://example.com' }), null);
  const commit = { channel: 'relay-setup-control-v1', type: 'setup_commit', operationId: 'setup-1' };
  assert.deepEqual(parseLauncherSetupControlCommit(commit), commit);
  assert.equal(parseLauncherSetupControlCommit({ ...commit, args: ['--force'] }), null);
  const statusRequest = { channel: 'relay-setup-control-v1', type: 'setup_status_request', requestId: 'status-1', operationId: 'setup-1' };
  assert.deepEqual(parseLauncherSetupStatusRequest(statusRequest), statusRequest);
  assert.equal(parseLauncherSetupStatusRequest({ ...statusRequest, path: 'G:/AI/relay' }), null);
  const statusResponse = createLauncherSetupStatusResponse(statusRequest, { operationId: 'setup-1', status: 'running', phase: 'verifying', reason: null, startedAt: 100, completedAt: null });
  assert.deepEqual(parseLauncherSetupStatusResponse(statusResponse), statusResponse);
  assert.equal(parseLauncherSetupStatusResponse({ ...statusResponse, command: 'npm run setup' }), null);
});

test('setup 响应仅接受固定阶段、终态和时间字段', () => {
  const accepted = createLauncherSetupResponse({ operationId: 'setup-1', status: 'accepted', phase: 'reserved', reason: null, startedAt: null, completedAt: null });
  assert.deepEqual(parseLauncherSetupResponse(accepted), accepted);
  const running = createLauncherSetupResponse({ operationId: 'setup-1', status: 'running', phase: 'verifying', reason: null, startedAt: 100, completedAt: null });
  assert.deepEqual(parseLauncherSetupResponse(running), running);
  const failed = createLauncherSetupResponse({ operationId: 'setup-1', status: 'failed', phase: 'failed', reason: 'setup_failed', startedAt: 100, completedAt: 200 });
  assert.deepEqual(parseLauncherSetupResponse(failed), failed);
  assert.equal(parseLauncherSetupResponse({ ...running, phase: 'shell' }), null);
  assert.equal(parseLauncherSetupResponse({ ...failed, detail: 'C:/secret' }), null);
});
