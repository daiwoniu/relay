import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { EngineMaintenanceRegistry } from '../engine/maintenance-registry.js';
import type { EngineMaintenanceAdapter } from '../engine/maintenance.js';
import { createEngineMaintenanceService, createProcessEngineMaintenanceService, EngineMaintenanceServiceError } from './engine-maintenance.js';

function adapter(active = 0): EngineMaintenanceAdapter {
  return {
    id: 'codex',
    async getStatus() { return {
      engineId: 'codex', label: 'Codex', installedVersion: '1.0.0', installedAt: 1_000_000_000_000, runningVersion: '1.0.0', latestVersion: '1.1.0', releaseOverview: null, updateAvailable: true,
      latestCheckStatus: 'success', latestCheckedAt: 1, installSource: 'official_npm_global', activeTaskCount: active, activeInstanceCount: 1,
      instanceVersions: [{ version: '1.0.0', count: 1 }], readiness: 'ready', readinessCheckedAt: 1, recommendedAction: 'upgrade_and_restart',
      actions: [
        { action: 'restart', label: '重启', enabled: true, reason: null, interruptsActiveTasks: active > 0 },
        { action: 'upgrade_and_restart', label: '升级', enabled: active === 0, reason: active ? '活动任务' : null, interruptsActiveTasks: false },
      ],
    }; },
    async checkLatest() { return this.getStatus(); },
  };
}

test('confirmation rechecks changed activity, authorization and expiry and sends at most once',async()=>{
  const admin={id:'1',username:'admin',role:'admin' as const};let tasks=0,commits=0,release!:()=>void;
  const dynamic={...adapter(),getStatus:()=>adapter(tasks).getStatus()};
  const service=createEngineMaintenanceService({registry:new EngineMaintenanceRegistry([dynamic]),isLauncherManaged:()=>true,send:()=>true,commit:()=>{commits++;return true;},createOperationId:()=> 'confirmation'});
  await service.reserve({user:admin,engineId:'codex',action:'restart'});tasks=1;
  assert.equal(await service.confirm('confirmation','codex','restart'),false);assert.equal(commits,0);tasks=0;
  await assert.rejects(()=>service.confirm('confirmation','codex','restart',async()=>{throw new EngineMaintenanceServiceError('forbidden');}),/forbidden/);
  const gate=new Promise<void>(resolve=>{release=resolve;});const first=service.confirm('confirmation','codex','restart',()=>gate);
  assert.equal(await service.confirm('confirmation','codex','restart'),false);release();assert.equal(await first,true);
  assert.equal(await service.confirm('confirmation','codex','restart'),true);assert.equal(commits,1);
  service.complete('confirmation','codex','restart','completed');
  await assert.rejects(()=>service.reserve({user:admin,engineId:'codex',action:'restart',reauthorize:async()=>{throw new EngineMaintenanceServiceError('forbidden');}}),/forbidden/);
  assert.equal(service.isOperationInProgress(),false);
});

test('Codex 活动任务要求显式确认普通重启并阻断升级', async () => {
  const sent = [];
  const service = createEngineMaintenanceService({
    registry: new EngineMaintenanceRegistry([adapter(1)]), isLauncherManaged: () => true,
    send: (message) => { sent.push(message); return true; }, commit: () => true, createOperationId: () => 'op-1',
  });
  await assert.rejects(() => service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'restart' }),
    (error: unknown) => error instanceof EngineMaintenanceServiceError && error.code === 'action_blocked');
  assert.equal((await service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'restart', confirmInterrupt: true })).status, 'reserved');
  assert.equal(sent.length, 1);
});

test('普通用户和未托管启动器不能预约引擎维护', async () => {
  const base = { registry: new EngineMaintenanceRegistry([adapter()]), send: () => true, commit: () => true };
  const service = createEngineMaintenanceService({ ...base, isLauncherManaged: () => false });
  await assert.rejects(() => service.reserve({ user: { id: '1', username: 'user', role: 'member' }, engineId: 'codex', action: 'restart' }), /forbidden/);
  await assert.rejects(() => service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'restart' }), /unmanaged/);
});

test('引擎维护保存处理中与权威终态，确认发送失败会释放闸门', async () => {
  const base = { registry: new EngineMaintenanceRegistry([adapter()]), isLauncherManaged: () => true, send: () => true, createOperationId: () => 'op-1' };
  const failedCommit = createEngineMaintenanceService({ ...base, commit: () => false });
  const reserved = await failedCommit.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'restart' });
  assert.equal(await failedCommit.confirm(reserved.operationId, reserved.engineId, reserved.action), false);
  assert.equal(failedCommit.isOperationInProgress(), false);
  assert.equal(failedCommit.getOperation('op-1')?.status, 'failed');

  const service = createEngineMaintenanceService({ ...base, commit: () => true });
  await service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'restart' });
  assert.equal(await service.confirm('op-1', 'codex', 'restart'), true);
  assert.equal(service.getOperation('op-1')?.status, 'processing');
  assert.equal(service.complete('op-1', 'codex', 'restart', 'completed'), true);
  assert.equal(service.getOperation('op-1')?.status, 'completed');
  assert.equal(service.getActiveEngineId(), null);
});

test('CodeBuddy 回退失败后持续阻断新会话直到进程重启', async () => {
  const codebuddy: EngineMaintenanceAdapter = {
    id: 'codebuddy',
    async getStatus() { return {
      ...(await adapter().getStatus()), engineId: 'codebuddy' as const, label: 'CodeBuddy', runningVersion: null,
      activeInstanceCount: 0, instanceVersions: [], recommendedAction: 'upgrade' as const,
      actions: [{ action: 'upgrade' as const, label: '升级', enabled: true, reason: null, interruptsActiveTasks: false }],
    }; },
    async checkLatest() { return this.getStatus(); },
  };
  const service = createEngineMaintenanceService({ ...{
    registry: new EngineMaintenanceRegistry([codebuddy]), isLauncherManaged: () => true,
    send: () => true, commit: () => true, createOperationId: () => 'op-rollback',
  } });
  await service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codebuddy', action: 'upgrade' });
  await service.confirm('op-rollback', 'codebuddy', 'upgrade');
  service.complete('op-rollback', 'codebuddy', 'upgrade', 'failed', 'rollback_failed');
  assert.equal(service.getEngineAdmissionBlock('codebuddy'), 'unavailable');
  assert.match((await service.getSnapshot()).engines[0]?.actions[0]?.reason || '', /终端修复/);
});

test('CodeBuddy 额度延期终态说明新版已安装并阻断当前进程会话', async () => {
  const codebuddy: EngineMaintenanceAdapter = {
    id: 'codebuddy',
    async getStatus() { return {
      ...(await adapter().getStatus()), engineId: 'codebuddy' as const, label: 'CodeBuddy', runningVersion: null,
      activeInstanceCount: 0, instanceVersions: [], recommendedAction: 'upgrade' as const,
      actions: [{ action: 'upgrade' as const, label: '升级', enabled: true, reason: null, interruptsActiveTasks: false }],
    }; },
    async checkLatest() { return this.getStatus(); },
  };
  const service = createEngineMaintenanceService({
    registry: new EngineMaintenanceRegistry([codebuddy]), isLauncherManaged: () => true,
    send: () => true, commit: () => true, createOperationId: () => 'op-quota',
  });
  await service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codebuddy', action: 'upgrade' });
  await service.confirm('op-quota', 'codebuddy', 'upgrade');
  service.complete('op-quota', 'codebuddy', 'upgrade', 'failed', 'quota_deferred');
  assert.match(service.getOperation('op-quota')?.message || '', /新版已安装.*额度.*重新检测/);
  assert.equal(service.getEngineAdmissionBlock('codebuddy'), 'unavailable');
});

test('CodeBuddy 额度未恢复的重新检测不会提示新版安装', async () => {
  const codebuddy: EngineMaintenanceAdapter = {
    id: 'codebuddy',
    async getStatus() { return {
      ...(await adapter().getStatus()), engineId: 'codebuddy' as const, label: 'CodeBuddy', runningVersion: null,
      activeInstanceCount: 0, instanceVersions: [], recommendedAction: null,
      actions: [{ action: 'recheck' as const, label: '重新检测', enabled: true, reason: null, interruptsActiveTasks: false }],
    }; },
    async checkLatest() { return this.getStatus(); },
  };
  const service = createEngineMaintenanceService({
    registry: new EngineMaintenanceRegistry([codebuddy]), isLauncherManaged: () => true,
    send: () => true, commit: () => true, createOperationId: () => 'op-recheck-quota',
  });
  await service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codebuddy', action: 'recheck' });
  await service.confirm('op-recheck-quota', 'codebuddy', 'recheck');
  service.complete('op-recheck-quota', 'codebuddy', 'recheck', 'failed', 'quota_deferred');
  const message = service.getOperation('op-recheck-quota')?.message || '';
  assert.match(message, /额度.*重新检测/);
  assert.doesNotMatch(message, /新版已安装/);
});

test('启动器拒绝原因保留操作中与冷却语义', async () => {
  const service = createEngineMaintenanceService({
    registry: new EngineMaintenanceRegistry([adapter()]), isLauncherManaged: () => true,
    send: () => ({ accepted: false, reason: 'rate_limited', retryAfterMs: 8_000 }), commit: () => true,
  });
  await assert.rejects(
    () => service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'restart' }),
    (error: unknown) => error instanceof EngineMaintenanceServiceError && error.code === 'rate_limited' && error.details.retryAfterMs === 8_000,
  );
});

test('Codex 维护预约携带后端冻结的受控项目根快照', async () => {
  const sent: any[] = [];
  const service = createEngineMaintenanceService({
    registry: new EngineMaintenanceRegistry([adapter()]), isLauncherManaged: () => true,
    send: (message) => { sent.push(message); return true; }, commit: () => true,
    getCodexWorkspaceRoots: () => ['G:\\AI\\relay', 'G:\\AI\\Codex\\xinshu'],
  });
  await service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'upgrade_and_restart' });
  assert.deepEqual(sent[0].workspaceRoots, ['G:\\AI\\relay', 'G:\\AI\\Codex\\xinshu']);
});

test('状态读取期间先占用目标引擎闸门，阻止并发新任务和第二个预约', async () => {
  let releaseStatus!: () => void;
  const delayed = adapter();
  const originalGetStatus = delayed.getStatus.bind(delayed);
  delayed.getStatus = async () => {
    await new Promise<void>((resolve) => { releaseStatus = resolve; });
    return originalGetStatus();
  };
  const service = createEngineMaintenanceService({
    registry: new EngineMaintenanceRegistry([delayed]), isLauncherManaged: () => true,
    send: () => true, commit: () => true, createOperationId: () => 'op-race',
  });
  const pending = service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'upgrade_and_restart' });
  await Promise.resolve();
  assert.equal(service.getEngineAdmissionBlock('codex'), 'maintenance');
  await assert.rejects(
    () => service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'restart' }),
    (error: unknown) => error instanceof EngineMaintenanceServiceError && error.code === 'operation_in_progress',
  );
  releaseStatus();
  assert.equal((await pending).status, 'reserved');
});

test('IPC 背压返回 false 但投递回调成功时仍确认维护操作', async () => {
  const listeners: Array<(message: unknown) => void> = [];
  const processLike = {
    env: { RELAY_LAUNCHER_CONTROL_VERSION: '6' },
    on: (_event: string, listener: (message: unknown) => void) => { listeners.push(listener); },
    send: (message: any, callback?: (error: Error | null) => void) => {
      if (message.type === 'engine_request') queueMicrotask(() => listeners[0]?.({ ...message, type: 'engine_response', status: 'accepted', reason: null, retryAfterMs: 0 }));
      else queueMicrotask(() => callback?.(null));
      return false;
    },
  };
  const { createProcessEngineMaintenanceService } = await import('./engine-maintenance.js');
  const service = createProcessEngineMaintenanceService(new EngineMaintenanceRegistry([adapter()]), processLike as any);
  const reserved = await service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'restart' });
  assert.equal(await service.confirm(reserved.operationId, 'codex', 'restart'), true);
  assert.equal(service.getOperation(reserved.operationId)?.status, 'processing');
});

test('旧启动器与维护处理中状态会投影为只读能力', async () => {
  const unmanaged = createEngineMaintenanceService({
    registry: new EngineMaintenanceRegistry([adapter()]), isLauncherManaged: () => false, send: () => true, commit: () => true,
  });
  assert.equal((await unmanaged.getSnapshot()).engines[0]?.actions.every((action) => !action.enabled), true);
  assert.match((await unmanaged.checkLatest('codex')).actions[0]?.reason || '', /npm run restart/);

  const active = createEngineMaintenanceService({
    registry: new EngineMaintenanceRegistry([adapter()]), isLauncherManaged: () => true, send: () => true, commit: () => true,
  });
  await active.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'restart' });
  assert.match((await active.getSnapshot()).engines[0]?.actions[0]?.reason || '', /已有维护操作/);
});

test('环境缺失或 Git 冲突会禁用并阻断引擎维护', async () => {
  for (const [environment, expected] of [
    [{ required: true, blockedByConflicts: false }, 'setup_required'],
    [{ required: false, blockedByConflicts: true }, 'setup_blocked'],
  ] as const) {
    const service = createEngineMaintenanceService({
      registry: new EngineMaintenanceRegistry([adapter()]), isLauncherManaged: () => true,
      send: () => true, commit: () => true, inspectEnvironment: () => environment,
    });
    assert.equal((await service.getSnapshot()).engines[0]?.actions.every((action) => !action.enabled), true);
    await assert.rejects(
      () => service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'restart' }),
      (error: unknown) => error instanceof EngineMaintenanceServiceError && error.code === expected,
    );
  }
});

test('进程引擎维护桥接按 operationId 查询维护输出', async () => {
  const processLike = new EventEmitter() as EventEmitter & { env: Record<string, string>; send: (message: any, callback?: (error: Error | null) => void) => void };
  processLike.env = { RELAY_LAUNCHER_CONTROL_VERSION: '6' };
  processLike.send = (message, callback) => {
    callback?.(null);
    if (message.type === 'output_status_request') queueMicrotask(() => processLike.emit('message', {
      channel: 'relay-maintenance-output-v1', type: 'output_status_response', requestId: message.requestId, operationId: message.operationId,
      output: { operationId: message.operationId, sequence: 4, lines: ['npm install'], status: 'running', updatedAt: 100 },
    }));
  };
  const service = createProcessEngineMaintenanceService(new EngineMaintenanceRegistry([adapter()]), processLike as any, { ipcSendTimeoutMs: 10 });
  assert.deepEqual(await service.getOperationOutput('engine-1'), { operationId: 'engine-1', sequence: 4, lines: ['npm install'], status: 'running', updatedAt: 100 });
});

test('进程桥接下中止请求收到 accepted 决策即视为已送达', async () => {
  const listeners: Array<(message: unknown) => void> = [];
  const processLike = {
    env: { RELAY_LAUNCHER_CONTROL_VERSION: '6' },
    on: (_event: string, listener: (message: unknown) => void) => { listeners.push(listener); },
    send: (message: any, callback?: (error: Error | null) => void) => {
      const respond = (patch: Record<string, unknown>) => queueMicrotask(() => listeners[0]?.({ channel: 'relay-engine-control-v1', type: 'engine_response', operationId: message.operationId, engineId: message.engineId, action: message.action, retryAfterMs: 0, ...patch }));
      if (message.type === 'engine_request') respond({ status: 'accepted', reason: null });
      else if (message.type === 'engine_abort') respond({ status: 'accepted', reason: null });
      else queueMicrotask(() => callback?.(null));
      return true;
    },
  };
  const service = createProcessEngineMaintenanceService(new EngineMaintenanceRegistry([adapter()]), processLike as any);
  const reserved = await service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'upgrade_and_restart' });
  await service.confirm(reserved.operationId, 'codex', 'upgrade_and_restart');
  assert.equal(await service.abortOperation(reserved.operationId, 'codex', 'upgrade_and_restart'), true);
  assert.equal(service.getOperation(reserved.operationId)?.status, 'processing');
});

test('进程桥接下启动器拒绝中止时报文校验通过且回传 operation_unknown', async () => {
  const listeners: Array<(message: unknown) => void> = [];
  const processLike = {
    env: { RELAY_LAUNCHER_CONTROL_VERSION: '6' },
    on: (_event: string, listener: (message: unknown) => void) => { listeners.push(listener); },
    send: (message: any, callback?: (error: Error | null) => void) => {
      const respond = (patch: Record<string, unknown>) => queueMicrotask(() => listeners[0]?.({ channel: 'relay-engine-control-v1', type: 'engine_response', operationId: message.operationId, engineId: message.engineId, action: message.action, retryAfterMs: 0, ...patch }));
      if (message.type === 'engine_request') respond({ status: 'accepted', reason: null });
      else if (message.type === 'engine_abort') respond({ status: 'rejected', reason: 'operation_unknown' });
      else queueMicrotask(() => callback?.(null));
      return true;
    },
  };
  const service = createProcessEngineMaintenanceService(new EngineMaintenanceRegistry([adapter()]), processLike as any);
  const reserved = await service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'upgrade_and_restart' });
  await service.confirm(reserved.operationId, 'codex', 'upgrade_and_restart');
  assert.equal(await service.abortOperation(reserved.operationId, 'codex', 'upgrade_and_restart'), true);
  const finished = service.getOperation(reserved.operationId);
  assert.equal(finished?.status, 'failed');
  assert.match(finished?.message || '', /启动器未找到该操作/);
  assert.equal(service.isOperationInProgress(), false);
});

test('commit 报文严格为协议五字段，不得携带 active 内部状态', async () => {
  const commits: any[] = [];
  const service = createEngineMaintenanceService({
    registry: new EngineMaintenanceRegistry([adapter()]), isLauncherManaged: () => true,
    send: () => true, createOperationId: () => 'op-shape',
    commit: (message) => { commits.push(message); return true; },
    now: () => 1_000,
  });
  await service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'upgrade_and_restart' });
  assert.equal(await service.confirm('op-shape', 'codex', 'upgrade_and_restart'), true);
  assert.deepEqual(Object.keys(commits[0]).sort(), ['action', 'channel', 'engineId', 'operationId', 'type']);
  assert.equal(commits[0].type, 'engine_commit');
});

test('进程桥接发出的 commit 报文能通过启动器严格解析', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { parseLauncherEngineControlCommit } = require('../../../scripts/lib/launcher-control.mjs');
  const sent: any[] = [];
  const listeners: Array<(message: unknown) => void> = [];
  const processLike = {
    env: { RELAY_LAUNCHER_CONTROL_VERSION: '6' },
    on: (_event: string, listener: (message: unknown) => void) => { listeners.push(listener); },
    send: (message: any, callback?: (error: Error | null) => void) => {
      if (message.type === 'engine_request') queueMicrotask(() => listeners[0]?.({ ...message, type: 'engine_response', status: 'accepted', reason: null, retryAfterMs: 0 }));
      else if (message.type === 'engine_commit') sent.push(message);
      queueMicrotask(() => callback?.(null));
      return true;
    },
  };
  const service = createProcessEngineMaintenanceService(new EngineMaintenanceRegistry([adapter()]), processLike as any);
  const reserved = await service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'upgrade_and_restart' });
  await service.confirm(reserved.operationId, 'codex', 'upgrade_and_restart');
  assert.equal(sent.length, 1);
  // 启动器解析器是本次事故的守门人：报文必须能被它原样接受。
  assert.deepEqual(parseLauncherEngineControlCommit(sent[0]), sent[0]);
});

test('处理中的操作超过阈值后标记停滞但不改变状态与闸门', async () => {
  let clock = 1_000_000;
  const service = createEngineMaintenanceService({
    registry: new EngineMaintenanceRegistry([adapter()]), isLauncherManaged: () => true,
    send: () => true, commit: () => true, createOperationId: () => 'op-stall', now: () => clock,
  });
  await service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'upgrade_and_restart' });
  await service.confirm('op-stall', 'codex', 'upgrade_and_restart');
  assert.equal(service.getOperation('op-stall')?.stalled ?? false, false);
  clock += 5 * 60_000;
  const stalled = service.getOperation('op-stall');
  assert.equal(stalled?.status, 'processing');
  assert.equal(stalled?.stalled, true);
  assert.equal(service.isOperationInProgress(), true);
  clock += 30_000;
  service.complete('op-stall', 'codex', 'upgrade_and_restart', 'completed');
  const finished = service.getOperation('op-stall');
  assert.equal(finished?.status, 'completed');
  assert.equal(finished?.stalled ?? false, false);
});

test('用户中止已送达启动器时保留 processing 等待失败终态', async () => {
  const aborts: any[] = [];
  const service = createEngineMaintenanceService({
    registry: new EngineMaintenanceRegistry([adapter()]), isLauncherManaged: () => true,
    send: () => true, commit: () => true, createOperationId: () => 'op-abort',
    abort: (message) => { aborts.push(message); return true; },
  });
  await service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'upgrade_and_restart' });
  await service.confirm('op-abort', 'codex', 'upgrade_and_restart');
  assert.equal(await service.abortOperation('op-abort', 'codex', 'upgrade_and_restart'), true);
  assert.equal(aborts.length, 1);
  assert.equal(aborts[0].type, 'engine_abort');
  assert.equal(service.getOperation('op-abort')?.status, 'processing');
  assert.equal(service.complete('op-abort', 'codex', 'upgrade_and_restart', 'failed', 'upgrade_failed'), true);
  assert.equal(service.getOperation('op-abort')?.status, 'failed');
});

test('启动器不认识操作时中止直接落失败终态释放闸门', async () => {
  const service = createEngineMaintenanceService({
    registry: new EngineMaintenanceRegistry([adapter()]), isLauncherManaged: () => true,
    send: () => true, commit: () => true, createOperationId: () => 'op-zombie',
    abort: () => ({ accepted: false, reason: 'operation_unknown' }),
  });
  await service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'upgrade_and_restart' });
  await service.confirm('op-zombie', 'codex', 'upgrade_and_restart');
  assert.equal(await service.abortOperation('op-zombie', 'codex', 'upgrade_and_restart'), true);
  const finished = service.getOperation('op-zombie');
  assert.equal(finished?.status, 'failed');
  assert.match(finished?.message || '', /中止/);
  assert.equal(service.isOperationInProgress(), false);
  assert.equal(service.getActiveEngineId(), null);
});

test('中止请求未送达时保留可重试的处理中状态', async () => {
  const service = createEngineMaintenanceService({
    registry: new EngineMaintenanceRegistry([adapter()]), isLauncherManaged: () => true,
    send: () => true, commit: () => true, createOperationId: () => 'op-unreachable',
    abort: () => false,
  });
  await service.reserve({ user: { id: '1', username: 'admin', role: 'admin' }, engineId: 'codex', action: 'upgrade_and_restart' });
  await service.confirm('op-unreachable', 'codex', 'upgrade_and_restart');
  assert.equal(await service.abortOperation('op-unreachable', 'codex', 'upgrade_and_restart'), false);
  assert.equal(service.getOperation('op-unreachable')?.status, 'processing');
  assert.equal(service.isOperationInProgress(), true);
});
