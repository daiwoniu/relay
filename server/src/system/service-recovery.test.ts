import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createServiceRecovery, ServiceRecoveryError } from './service-recovery.js';

const admin = { id: '1', username: 'admin', role: 'admin' as const };
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
function create(overrides: Record<string, unknown> = {}) {
  const sent: unknown[] = [];
  const service = createServiceRecovery({
    isLauncherManaged: () => true, countActiveTasks: () => 0,
    getLauncherControlVersion: () => 5,
    sendControlMessage: (message: unknown) => { sent.push(message); return true; }, commitControlMessage: () => true,
    sendSetupMessage: (message: unknown) => { sent.push(message); return true; }, commitSetupMessage: () => true,
    getControlStatus: async () => ({ backendRetryAfterMs: 0, frontendRetryAfterMs: 0, operationInProgress: false }),
    getRuntimeStatus: async () => ({ frontendMode: 'production', activeBuildId: null, activeBuildLabel: null, frontendBuildRequired: true, frontendBuildReason: '源码已更新' }),
    inspectEnvironment: () => ({ required: false, blockedByConflicts: false, server: { needed: false, reason: '已初始化' }, client: { needed: false, reason: '已初始化' } }),
    createOperationId: () => 'op-1', now: () => 1000,
    ...overrides,
  } as any);
  return { service, sent };
}

test('async task reads hold the maintenance mutex and failures never issue launcher requests',async()=>{
  const count=deferred<number>();const {service,sent}=create({countActiveTasks:()=>count.promise});
  const first=service.requestRecovery({user:admin,action:'restart_relay',clientProtocolVersion:10});
  assert.equal(service.isOperationInProgress(),true);
  await assert.rejects(()=>service.requestRecovery({user:admin,action:'restart_frontend',clientProtocolVersion:10}),/operation_in_progress/);
  count.resolve(1);await assert.rejects(()=>first,/active_tasks/);assert.equal(sent.length,0);assert.equal(service.isOperationInProgress(),false);
  const broken=create({countActiveTasks:async()=>{throw new Error('database unavailable');}});
  await assert.rejects(()=>broken.service.requestRecovery({user:admin,action:'restart_relay',clientProtocolVersion:10}),/database unavailable/);
  assert.equal(broken.sent.length,0);assert.equal(broken.service.isOperationInProgress(),false);
});

test('fresh authorization precedes launcher effects and concurrent confirmations commit once',async()=>{
  const denied=create();
  await assert.rejects(()=>denied.service.requestRecovery({user:admin,action:'restart_backend',clientProtocolVersion:10,reauthorize:async()=>{throw new Error('revoked');}}),/revoked/);
  assert.equal(denied.sent.length,0);assert.equal(denied.service.isOperationInProgress(),false);
  let commits=0;const authorization=deferred<void>();
  const {service}=create({commitControlMessage:()=>{commits++;return true;}});
  await service.requestRecovery({user:admin,action:'restart_relay',clientProtocolVersion:10});
  await assert.rejects(()=>service.confirmOperation('op-1','relay',async()=>{throw new Error('revoked');}),/revoked/);assert.equal(commits,0);
  const confirming=service.confirmOperation('op-1','relay',()=>authorization.promise);
  assert.equal(await service.confirmOperation('op-1','relay'),false);authorization.resolve();
  assert.equal(await confirming,true);assert.equal(await service.confirmOperation('op-1','relay'),true);assert.equal(commits,1);
});

test('服务维护能力只包含前端和后端且环境异常时禁用', async () => {
  const { service } = create({ inspectEnvironment: () => ({ required: true, blockedByConflicts: false, server: { needed: true, reason: '需要 setup' }, client: { needed: false, reason: '已初始化' } }) });
  const capability = await service.getCapabilities(admin);
  assert.equal(capability.canRestartBackend, false);
  assert.equal(capability.canRestartFrontend, false);
  assert.equal(capability.canRepairEnvironment, true);
  assert.equal('canRestartCodex' in capability, false);
  assert.equal('canInitialize' in capability.setup, false);
});

test('环境修复只在异常且无活动任务时预约并二阶段确认', async () => {
  const environment = () => ({ required: true, blockedByConflicts: false, server: { needed: true, reason: '需要 setup' }, client: { needed: false, reason: '已初始化' } });
  const { service, sent } = create({ inspectEnvironment: environment });
  const reserved = await service.requestRecovery({ user: admin, action: 'repair_environment', clientProtocolVersion: 10 });
  assert.equal(reserved.target, 'setup');
  assert.equal((sent[0] as any).channel, 'relay-setup-control-v1');
  assert.equal(await service.confirmOperation('op-1', 'setup'), true);

  const busy = create({ inspectEnvironment: environment, countActiveTasks: () => 1 });
  await assert.rejects(() => busy.service.requestRecovery({ user: admin, action: 'repair_environment', clientProtocolVersion: 10 }),
    (error: unknown) => error instanceof ServiceRecoveryError && error.code === 'active_tasks');
});

test('setup 权威终态会释放全局维护互斥并保留最近结果', async () => {
  const environment = () => ({ required: true, blockedByConflicts: false, server: { needed: true, reason: '需要 setup' }, client: { needed: false, reason: '已初始化' } });
  const { service } = create({ inspectEnvironment: environment });
  await service.requestRecovery({ user: admin, action: 'repair_environment', clientProtocolVersion: 10 });
  service.updateSetupOperation({ operationId: 'op-1', status: 'completed', phase: 'completed', reason: null, startedAt: 1000, completedAt: 2000 });
  assert.equal(service.isOperationInProgress(), false);
  assert.equal((await service.getCapabilities(admin)).setupOperation?.status, 'completed');
});

test('旧启动器仍识别为受管但只允许完整终端换代', async () => {
  const listeners: Array<(message: unknown) => void> = [];
  const processLike = { env: { RELAY_LAUNCHER_CONTROL_VERSION: '3' }, on: (_event: string, listener: (message: unknown) => void) => listeners.push(listener), send: () => true };
  const { createProcessServiceRecovery } = await import('./service-recovery.js');
  const service = createProcessServiceRecovery({ processLike, countActiveTasks: () => 0, inspectEnvironment: () => ({ required: false, blockedByConflicts: false, server: { needed: false, reason: 'ok' }, client: { needed: false, reason: 'ok' } }) });
  const legacy = await service.getCapabilities(admin);
  assert.equal(legacy.managedByLauncher, true);
  assert.equal(legacy.launcherCompatible, false);
  assert.equal(legacy.launcherControlVersion, 3);
  assert.equal(legacy.canRestartRelay, false);
  processLike.env.RELAY_LAUNCHER_CONTROL_VERSION = '4';
  const current = await service.getCapabilities(admin);
  assert.equal(current.managedByLauncher, true);
  assert.equal(current.launcherCompatible, false);
  assert.equal(current.canRestartRelay, false);
  processLike.env.RELAY_LAUNCHER_CONTROL_VERSION = '5';
  const future = await service.getCapabilities(admin);
  assert.equal(future.managedByLauncher, true);
  assert.equal(future.launcherCompatible, true);
  assert.equal(future.canRestartRelay, true);
});

test('能力查询从启动器恢复最近 setup 终态快照', async () => {
  const operation = { operationId: 'setup-old', status: 'failed', phase: 'failed', reason: 'setup_failed', startedAt: 100, completedAt: 200 } as const;
  const { service } = create({ getSetupStatus: async () => operation });
  assert.deepEqual((await service.getCapabilities(admin)).setupOperation, operation);
});

test('活动任务阻断后端重启但不阻断前端重启', async () => {
  const backend = create({ countActiveTasks: () => 1 });
  await assert.rejects(() => backend.service.requestRecovery({ user: admin, action: 'restart_backend', clientProtocolVersion: 10 }),
    (error: unknown) => error instanceof ServiceRecoveryError && error.code === 'active_tasks');
  assert.equal((await backend.service.requestRecovery({ user: admin, action: 'restart_frontend', clientProtocolVersion: 10 })).status, 'accepted');
});

test('完整重启 Relay 必须无活动任务并发送固定 relay 目标', async () => {
  const { service, sent } = create();
  const reserved = await service.requestRecovery({ user: admin, action: 'restart_relay', clientProtocolVersion: 10 });
  assert.equal(reserved.target, 'relay');
  assert.equal((sent[0] as any).target, 'relay');
  const busy = create({ countActiveTasks: () => 1 });
  await assert.rejects(() => busy.service.requestRecovery({ user: admin, action: 'restart_relay', clientProtocolVersion: 10 }),
    (error: unknown) => error instanceof ServiceRecoveryError && error.code === 'active_tasks');
  await assert.rejects(() => busy.service.requestRecovery({ user: admin, action: 'restart_relay', clientProtocolVersion: 10, confirmActiveTasks: true }),
    (error: unknown) => error instanceof ServiceRecoveryError && error.code === 'active_tasks');

  let activeTaskCount = 0;
  const raced = create({ countActiveTasks: () => activeTaskCount });
  await raced.service.requestRecovery({ user: admin, action: 'restart_relay', clientProtocolVersion: 10 });
  activeTaskCount = 1;
  assert.equal(await raced.service.confirmOperation('op-1', 'relay'), false);
});

test('服务恢复只发送 backend/frontend 严格目标并二阶段确认', async () => {
  const { service, sent } = create();
  const reserved = await service.requestRecovery({ user: admin, action: 'restart_backend', clientProtocolVersion: 10 });
  assert.equal(reserved.target, 'backend');
  assert.equal((sent[0] as any).target, 'backend');
  assert.equal(await service.confirmOperation('op-1', 'backend'), true);
});

test('服务确认投递失败时保留预约超时，避免永久锁定维护状态', async () => {
  let expire!: () => void;
  const { service } = create({
    commitControlMessage: () => false,
    scheduleOperationExpiry: (callback: () => void) => { expire = callback; return () => undefined; },
  });
  await service.requestRecovery({ user: admin, action: 'restart_backend', clientProtocolVersion: 10 });
  assert.equal(await service.confirmOperation('op-1', 'backend'), false);
  assert.equal(service.isOperationInProgress(), true);
  expire();
  assert.equal(service.isOperationInProgress(), false);
});

test('完整重启预备失败时确认接口返回明确错误并释放维护互斥', async () => {
  const { service } = create({
    commitControlMessage: () => ({ status: 'failed', message: '前端构建体积超限。完整重启已取消，现有服务仍在运行。' }),
  });
  await service.requestRecovery({ user: admin, action: 'restart_relay', clientProtocolVersion: 10 });
  await assert.rejects(() => service.confirmOperation('op-1', 'relay'),
    (error: unknown) => error instanceof ServiceRecoveryError
      && error.code === 'restart_failed'
      && error.details.message?.includes('现有服务仍在运行'));
  assert.equal(service.isOperationInProgress(), false);
});

test('进程恢复桥接等待完整重启终态并转交安全失败说明', async () => {
  const processLike = new EventEmitter() as EventEmitter & { env: Record<string, string>; send: (message: any, callback?: (error: Error | null) => void) => void };
  processLike.env = { RELAY_LAUNCHER_CONTROL_VERSION: '5' };
  processLike.send = (message, callback) => {
    callback?.(null);
    if (message.type === 'restart_request') queueMicrotask(() => processLike.emit('message', {
      channel: 'relay-control-v1', type: 'restart_response', operationId: message.operationId, target: 'relay',
      status: 'accepted', reason: null, retryAfterMs: 0, message: null,
    }));
    if (message.type === 'restart_commit') queueMicrotask(() => processLike.emit('message', {
      channel: 'relay-control-v1', type: 'restart_response', operationId: message.operationId, target: 'relay',
      status: 'failed', reason: null, retryAfterMs: 0, message: '体积超限。完整重启已取消，现有服务仍在运行。',
    }));
  };
  const { createProcessServiceRecovery } = await import('./service-recovery.js');
  const service = createProcessServiceRecovery({
    processLike, countActiveTasks: () => 0,
    inspectEnvironment: () => ({ required: false, blockedByConflicts: false, server: { needed: false, reason: 'ok' }, client: { needed: false, reason: 'ok' } }),
  });
  const reserved = await service.requestRecovery({ user: admin, action: 'restart_relay', clientProtocolVersion: 10 });
  assert.equal(reserved.status, 'accepted');
  if (reserved.status !== 'accepted') assert.fail('完整重启应先返回 accepted');
  await assert.rejects(() => service.confirmOperation(reserved.operationId, 'relay'),
    (error: unknown) => error instanceof ServiceRecoveryError && error.details.message?.includes('现有服务仍在运行') === true);
});

test('进程恢复桥接按 operationId 查询维护输出且超时安全降级', async () => {
  const processLike = new EventEmitter() as EventEmitter & { env: Record<string, string>; send: (message: any, callback?: (error: Error | null) => void) => void };
  processLike.env = { RELAY_LAUNCHER_CONTROL_VERSION: '6' };
  processLike.send = (message, callback) => {
    callback?.(null);
    if (message.type === 'output_status_request' && message.operationId === 'op-1') queueMicrotask(() => processLike.emit('message', {
      channel: 'relay-maintenance-output-v1', type: 'output_status_response', requestId: message.requestId, operationId: 'op-1',
      output: { operationId: 'op-1', sequence: 2, lines: ['正在构建'], status: 'running', updatedAt: 100 },
    }));
  };
  const { createProcessServiceRecovery } = await import('./service-recovery.js');
  const service = createProcessServiceRecovery({
    processLike, ipcSendTimeoutMs: 5, countActiveTasks: () => 0,
    inspectEnvironment: () => ({ required: false, blockedByConflicts: false, server: { needed: false, reason: 'ok' }, client: { needed: false, reason: 'ok' } }),
  });
  assert.deepEqual(await service.getOperationOutput('op-1'), { operationId: 'op-1', sequence: 2, lines: ['正在构建'], status: 'running', updatedAt: 100 });
  assert.equal(await service.getOperationOutput('missing'), null);
});
