import assert from 'node:assert/strict';
import test from 'node:test';
import { createServiceSupervisor, formatRelayRestartPreparationFailure } from './lib/service-supervisor.mjs';

const services = new Map([
  ['backend', { id: 'backend', name: 'Relay 后端', healthUrl: 'http://backend' }],
  ['frontend', { id: 'frontend', name: 'Vite 前端', healthUrl: 'http://frontend' }],
  ['codex', { id: 'codex', name: 'Codex', healthUrl: 'http://codex' }],
]);

function child(pid) {
  return { pid, exitCode: null, signalCode: null };
}

function message(target = 'backend', operationId = 'op-1') {
  return {
    channel: 'relay-control-v1',
    type: 'restart_request',
    operationId,
    target,
    requestedBy: 'admin',
    clientProtocolVersion: 11,
    serverProtocolVersion: 10,
  };
}

function createHarness(overrides = {}) {
  const harnessServices = new Map([...services].map(([id, service]) => [id, { ...service }]));
  const backend = child(101);
  const frontend = child(202);
  const codex = child(203);
  const owned = new Map([
    ['backend', { service: harnessServices.get('backend'), child: backend }],
    ['frontend', { service: harnessServices.get('frontend'), child: frontend }],
    ['codex', { service: harnessServices.get('codex'), child: codex, startedAt: Date.UTC(2026, 7, 6, 1, 2, 3) }],
  ]);
  const stopped = [];
  const spawned = [];
  const output = [];
  const errors = [];
  const responses = [];
  let nextPid = 300;
  let now = Date.UTC(2026, 7, 6, 1, 2, 3);
  const supervisor = createServiceSupervisor({
    services: harnessServices,
    owned,
    stopChild: async (targetChild) => {
      stopped.push(targetChild.pid);
      targetChild.exitCode = 0;
    },
    spawnChild: (service) => {
      const next = child(nextPid++);
      spawned.push(service.id);
      return next;
    },
    waitForReady: async () => {},
    getCapturedOutput: () => '',
    sendControlResponse: async (targetChild, response) => {
      responses.push({ pid: targetChild.pid, response });
      return true;
    },
    write: (line) => output.push(line),
    writeError: (line) => errors.push(line),
    getCodexStatus: () => ({ version: '0.146.0', installSource: 'npm_global', upgradeSupported: true, upgradeReason: null }),
    verifyCodexSandboxHealth: async () => {},
    getCodeBuddyStatus: () => ({ version: '2.140.0', installSource: 'npm_global', upgradeSupported: true, upgradeReason: null }),
    rollbackCodexUpgrade: async () => {},
    runCodeBuddyUpgrade: async () => {},
    runCodeBuddyReadiness: async () => {},
    rollbackCodeBuddyUpgrade: async () => {},
    now: () => now,
    ...overrides,
  });
  return {
    supervisor, owned, backend, frontend, codex, stopped, spawned, output, errors, responses,
    advance(milliseconds) { now += milliseconds; },
  };
}

function commit(target = 'backend', operationId = 'op-1') {
  return { channel: 'relay-control-v1', type: 'restart_commit', operationId, target };
}

function engineMessage(engineId, action, operationId = 'engine-1') {
  return {
    channel: 'relay-engine-control-v1', type: 'engine_request', operationId, engineId, action, requestedBy: 'admin',
    workspaceRoots: engineId === 'codex' ? ['G:\\AI\\Codex\\xinshu'] : [],
  };
}

function engineCommit(engineId, action, operationId = 'engine-1') {
  return { channel: 'relay-engine-control-v1', type: 'engine_commit', operationId, engineId, action };
}

function setupMessage(operationId = 'setup-1') {
  return { channel: 'relay-setup-control-v1', type: 'setup_request', operationId, requestedBy: 'admin' };
}

function setupCommit(operationId = 'setup-1') {
  return { channel: 'relay-setup-control-v1', type: 'setup_commit', operationId };
}

const codexLifecycle = (type) => ({ channel: 'relay-codex-lifecycle-v1', type });

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('Codex 空闲超过阈值后停止，重新出现活动时取消停止并保留进程', async () => {
  const harness = createHarness({ codexIdleTimeoutMs: 10, codexIdleShutdownEnabled: true });
  assert.equal((await harness.supervisor.handleCodexLifecycleMessage(harness.backend, codexLifecycle('idle'))).ok, true);
  await wait(25);
  assert.deepEqual(harness.stopped, [203]);

  harness.owned.delete('codex');
  assert.equal((await harness.supervisor.handleCodexLifecycleMessage(harness.backend, codexLifecycle('activity_started'))).ok, true);
  assert.deepEqual(harness.spawned, ['codex']);
  assert.equal(harness.owned.get('codex').child.pid, 300);
  assert.ok(harness.output.some(line=>line.includes('Codex：收到会话连接请求，正在按需启动...')));
  assert.ok(harness.output.some(line=>line.endsWith('Codex：已就绪')));
  assert.ok(harness.output.every(line=>!line.includes('PID 300')),'process IDs belong in the file log rather than startup progress');

  assert.equal((await harness.supervisor.handleCodexLifecycleMessage(harness.backend, codexLifecycle('idle'))).ok, true);
  await wait(2);
  assert.equal((await harness.supervisor.handleCodexLifecycleMessage(harness.backend, codexLifecycle('activity_started'))).ok, true);
  await wait(20);
  assert.deepEqual(harness.stopped, [203]);
});

test('完整重启预备失败只向页面返回受限体积摘要', () => {
  const error = new Error('node budget 执行失败：\nJavaScript 构建预算：最大 chunk 500.00 KiB，总量 1200.00 KiB\n- 总量: 1203.15 KiB\n超出 JavaScript 总量预算');
  assert.equal(formatRelayRestartPreparationFailure(error), '前端构建体积超限：JavaScript 总量 1203.15 / 1200.00 KiB，超出 3.15 KiB。完整重启已取消，现有服务仍在运行。');
  const gzipError = new Error('JavaScript 构建预算：最大 chunk 500.00 KiB，总量 1300.00 KiB\n传输与离线脚本预算：gzip 总量 400.00 KiB，离线脚本 4.00 KiB\n- gzip 总量: 402.20 KiB\n超出 JavaScript gzip 总量预算');
  assert.equal(formatRelayRestartPreparationFailure(gzipError), '前端构建体积超限：JavaScript gzip 总量 402.20 / 400.00 KiB。完整重启已取消，现有服务仍在运行。');
  const offlineError = new Error('JavaScript 构建预算：最大 chunk 500.00 KiB，总量 1300.00 KiB\n传输与离线脚本预算：gzip 总量 400.00 KiB，离线脚本 4.00 KiB\n- 离线脚本: 4.25 KiB\n超出离线分享脚本预算');
  assert.equal(formatRelayRestartPreparationFailure(offlineError), '前端构建体积超限：离线分享脚本 4.25 / 4.00 KiB。完整重启已取消，现有服务仍在运行。');
  assert.equal(formatRelayRestartPreparationFailure(new Error('构建失败 C:\\secret token=abc')), '完整重启准备失败。完整重启已取消，现有服务仍在运行；请查看启动终端中的构建详情。');
});

test('禁用空闲回收时Codex保持运行且按需唤醒仍然可用', async () => {
  const harness = createHarness({ codexIdleShutdownEnabled: false, codexIdleTimeoutMs: 1 });
  const result = await harness.supervisor.handleCodexLifecycleMessage(harness.backend, codexLifecycle('idle'));
  assert.equal(result.status, 'kept_running');
  await wait(10);
  assert.deepEqual(harness.stopped, []);
  harness.owned.delete('codex');
  await harness.supervisor.handleCodexLifecycleMessage(harness.backend, codexLifecycle('activity_started'));
  assert.deepEqual(harness.spawned, ['codex']);
});

test('setup 状态查询返回最近权威快照并拒绝其他 operationId', async () => {
  const harness = createHarness({ inspectEnvironment: () => ({ dependenciesReady: false, conflictFiles: [] }) });
  await harness.supervisor.handleSetupControlMessage(harness.backend, setupMessage());
  const request = { channel: 'relay-setup-control-v1', type: 'setup_status_request', requestId: 'status-1', operationId: 'setup-1' };
  assert.equal((await harness.supervisor.handleSetupStatusMessage(harness.backend, request)).operation?.phase, 'reserved');
  assert.equal((await harness.supervisor.handleSetupStatusMessage(harness.backend, { ...request, requestId: 'status-2', operationId: 'other' })).operation, null);
});

test('维护输出查询仅返回匹配 operationId 的最近快照', async () => {
  const harness = createHarness();
  await harness.supervisor.handleControlMessage(harness.backend, message('frontend', 'output-op'));
  const request = { channel: 'relay-maintenance-output-v1', type: 'output_status_request', requestId: 'output-1', operationId: 'output-op' };
  const result = await harness.supervisor.handleMaintenanceOutputMessage(harness.backend, request);
  assert.equal(result.output?.operationId, 'output-op');
  assert.equal(result.output?.status, 'running');
  assert.equal(result.output?.lines.length, 1);

  const missing = await harness.supervisor.handleMaintenanceOutputMessage(harness.backend, { ...request, requestId: 'output-2', operationId: 'other' });
  assert.equal(missing.output, null);
  assert.equal(harness.responses.at(-1)?.response.output, null);
});

test('环境修复仅在依赖异常时接受并按固定阶段完成', async () => {
  const phases = [];
  const harness = createHarness({
    inspectEnvironment: () => ({ dependenciesReady: false, conflictFiles: [] }),
    runEnvironmentSetup: async (reportPhase) => {
      for (const phase of ['server_dependencies', 'client_dependencies', 'verifying']) {
        phases.push(phase);
        await reportPhase(phase);
      }
    },
  });
  assert.equal((await harness.supervisor.handleSetupControlMessage(harness.backend, setupMessage())).status, 'accepted');
  const result = await harness.supervisor.handleSetupControlCommit(harness.backend, setupCommit());
  assert.equal(result.ok, true);
  assert.deepEqual(phases, ['server_dependencies', 'client_dependencies', 'verifying']);
  assert.equal(harness.responses.at(-1).response.status, 'completed');
  assert.equal(harness.responses.at(-1).response.phase, 'completed');
  assert.deepEqual(harness.stopped, []);
});

test('环境正常、Git 冲突和其他维护操作会阻断 setup', async () => {
  const ready = createHarness({ inspectEnvironment: () => ({ dependenciesReady: true, conflictFiles: [] }) });
  assert.equal((await ready.supervisor.handleSetupControlMessage(ready.backend, setupMessage())).reason, 'environment_ready');
  const conflicted = createHarness({ inspectEnvironment: () => ({ dependenciesReady: false, conflictFiles: ['x'] }) });
  assert.equal((await conflicted.supervisor.handleSetupControlMessage(conflicted.backend, setupMessage())).reason, 'setup_blocked');
  const busy = createHarness({ inspectEnvironment: () => ({ dependenciesReady: false, conflictFiles: [] }) });
  await busy.supervisor.handleSetupControlMessage(busy.backend, setupMessage());
  assert.equal((await busy.supervisor.handleControlMessage(busy.backend, message('frontend'))).reason, 'operation_in_progress');
});

test('setup 失败形成明确失败终态并释放全局互斥', async () => {
  const harness = createHarness({
    inspectEnvironment: () => ({ dependenciesReady: false, conflictFiles: [] }),
    runEnvironmentSetup: async () => { throw new Error('npm ci failed at C:/secret'); },
  });
  await harness.supervisor.handleSetupControlMessage(harness.backend, setupMessage());
  const result = await harness.supervisor.handleSetupControlCommit(harness.backend, setupCommit());
  assert.equal(result.reason, 'setup_failed');
  assert.equal(harness.responses.at(-1).response.reason, 'setup_failed');
  assert.equal(harness.supervisor.getActiveRestart(), null);
  assert.doesNotMatch(JSON.stringify(harness.responses.at(-1).response), /C:\/secret/);
});

test('重启 backend 只停止并替换 backend', async () => {
  const harness = createHarness();
  assert.equal((await harness.supervisor.handleControlMessage(harness.backend, message('backend'))).status, 'accepted');
  const result = await harness.supervisor.handleControlCommit(harness.backend, commit('backend'));
  assert.equal(result.ok, true);
  assert.deepEqual(harness.stopped, [101]);
  assert.deepEqual(harness.spawned, ['backend']);
  assert.equal(harness.owned.get('backend').child.pid, 300);
  assert.equal(harness.owned.get('frontend').child, harness.frontend);
  assert.equal(harness.responses[0].response.status, 'accepted');
});

test('重启 frontend 只停止并替换 frontend', async () => {
  const harness = createHarness();
  await harness.supervisor.handleControlMessage(harness.backend, message('frontend'));
  const result = await harness.supervisor.handleControlCommit(harness.backend, commit('frontend'));
  assert.equal(result.ok, true);
  assert.deepEqual(harness.stopped, [202]);
  assert.deepEqual(harness.spawned, ['frontend']);
  assert.equal(harness.owned.get('backend').child, harness.backend);
  assert.deepEqual(harness.responses.map(({ response }) => response.status), ['accepted', 'completed']);
});

test('重启 Codex 只替换 app-server 并向后端发送完成回执', async () => {
  const harness = createHarness();
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codex', 'restart'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codex', 'restart'));
  assert.equal(result.ok, true);
  assert.deepEqual(harness.stopped, [203]);
  assert.deepEqual(harness.spawned, ['codex']);
  assert.equal(harness.owned.get('codex').child.pid, 300);
  assert.deepEqual(harness.responses.map(({ response }) => response.status), ['accepted', 'completed']);
});

test('升级 Codex 只执行固定升级器，验证后恢复 app-server', async () => {
  let upgraded = 0;
  const harness = createHarness({ runCodexUpgrade: async () => { upgraded += 1; } });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codex', 'upgrade_and_restart'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codex', 'upgrade_and_restart'));
  assert.equal(result.ok, true);
  assert.equal(upgraded, 1);
  assert.deepEqual(harness.stopped, [203]);
  assert.deepEqual(harness.spawned, ['codex']);
  assert.deepEqual(harness.responses.map(({ response }) => response.status), ['accepted', 'completed']);
});

test('Codex 升级失败时回退旧版本并恢复 app-server', async () => {
  const calls = [];
  const harness = createHarness({
    runCodexUpgrade: async () => { calls.push('upgrade'); throw new Error('install failed'); },
    rollbackCodexUpgrade: async (version) => calls.push(`rollback:${version}`),
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codex', 'upgrade_and_restart'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codex', 'upgrade_and_restart'));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upgrade_failed');
  assert.deepEqual(calls, ['upgrade', 'rollback:0.146.0']);
  assert.equal(harness.owned.has('codex'), true);
  assert.equal(harness.responses.at(-1).response.reason, 'upgrade_failed');
});

test('Codex 升级验证失败按安装、验证、回退和恢复顺序报告阶段', async () => {
  const stages = [];
  const outputStore = {
    start() {}, append() {}, finish() {}, getSnapshot() { return null; },
    appendStage(_operationId, line) { stages.push(line); },
  };
  let version = '0.146.0';
  const harness = createHarness({
    maintenanceOutputStore: outputStore,
    getCodexStatus: () => ({ version, installSource: 'npm_global', upgradeSupported: true, upgradeReason: null }),
    runCodexUpgrade: async () => { version = '0.147.0'; },
    verifyCodexSandboxHealth: async () => { if (version === '0.147.0') throw new Error('sandbox failed'); },
    rollbackCodexUpgrade: async () => { version = '0.146.0'; },
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codex', 'upgrade_and_restart'));
  await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codex', 'upgrade_and_restart'));
  assert.ok(stages.indexOf('正在升级 Codex npm 包') < stages.indexOf('正在验证 Codex sandbox'));
  assert.ok(stages.indexOf('正在回退 Codex') < stages.indexOf('正在恢复 Codex app-server'));
});

test('Codex 升级后安装来源验证失败时按失败事务回退', async () => {
  let checks = 0;
  const calls = [];
  const harness = createHarness({
    getCodexStatus: () => checks++ === 2
      ? { version: '0.147.0', installSource: 'unknown', upgradeSupported: false, upgradeReason: '来源不一致' }
      : { version: '0.146.0', installSource: 'npm_global', upgradeSupported: true, upgradeReason: null },
    runCodexUpgrade: async () => calls.push('upgrade'),
    rollbackCodexUpgrade: async (version) => calls.push(`rollback:${version}`),
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codex', 'upgrade_and_restart'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codex', 'upgrade_and_restart'));
  assert.equal(result.reason, 'upgrade_failed');
  assert.deepEqual(calls, ['upgrade', 'rollback:0.146.0']);
});

test('Codex 升级后 sandbox 健康检查失败时回退并在回退后复验', async () => {
  const calls = [];
  const harness = createHarness({
    runCodexUpgrade: async () => calls.push('upgrade'),
    verifyCodexSandboxHealth: async () => {
      calls.push('verify');
      if (calls.filter((item) => item === 'verify').length === 1) throw new Error('Codex sandbox provisioning 异常');
    },
    rollbackCodexUpgrade: async (version) => calls.push(`rollback:${version}`),
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codex', 'upgrade_and_restart'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codex', 'upgrade_and_restart'));
  assert.equal(result.reason, 'upgrade_failed');
  assert.deepEqual(calls, ['upgrade', 'verify', 'rollback:0.146.0', 'verify']);
  assert.equal(harness.owned.has('codex'), true);
});

test('Codex 回退后 sandbox 仍异常时记录诊断且不报告恢复成功', async () => {
  const harness = createHarness({
    runCodexUpgrade: async () => {},
    verifyCodexSandboxHealth: async () => { throw new Error('Codex sandbox provisioning 异常'); },
    rollbackCodexUpgrade: async () => {},
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codex', 'upgrade_and_restart'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codex', 'upgrade_and_restart'));
  assert.equal(result.reason, 'rollback_failed');
  assert.equal(harness.output.some((line) => /已恢复到升级前版本/.test(line)), false);
  assert.equal(harness.errors.some((line) => /回退后 sandbox 健康检查失败/.test(line)), true);
  assert.equal(harness.owned.has('codex'), false);
});

test('Codex 回退命令失败时保持停止且返回 rollback_failed', async () => {
  const roots = [];
  const harness = createHarness({
    runCodexUpgrade: async () => { throw new Error('upgrade failed'); },
    rollbackCodexUpgrade: async () => { throw new Error('rollback failed'); },
    verifyCodexSandboxHealth: async (workspaceRoots) => roots.push(workspaceRoots),
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codex', 'upgrade_and_restart'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codex', 'upgrade_and_restart'));
  assert.equal(result.reason, 'rollback_failed');
  assert.equal(harness.owned.has('codex'), false);
  assert.deepEqual(harness.spawned, []);
  assert.deepEqual(roots, []);
  assert.equal(harness.responses.at(-1).response.reason, 'rollback_failed');
});

test('Codex 无可靠旧版本可回退时保持停止且返回 rollback_failed', async () => {
  let reads = 0;
  const harness = createHarness({
    getCodexStatus: () => ++reads === 1
      ? { version: '0.146.0', installSource: 'npm_global', upgradeSupported: true, upgradeReason: null }
      : { version: null, installSource: 'unknown', upgradeSupported: false, upgradeReason: '版本不可读' },
    runCodexUpgrade: async () => { throw new Error('upgrade failed'); },
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codex', 'upgrade_and_restart'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codex', 'upgrade_and_restart'));
  assert.equal(result.reason, 'rollback_failed');
  assert.equal(harness.owned.has('codex'), false);
  assert.deepEqual(harness.spawned, []);
});

test('Codex 升级和回退复验使用预约时冻结的工作区快照', async () => {
  const roots = [];
  const harness = createHarness({
    runCodexUpgrade: async () => {},
    verifyCodexSandboxHealth: async (workspaceRoots) => roots.push(workspaceRoots),
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codex', 'upgrade_and_restart'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codex', 'upgrade_and_restart'));
  assert.equal(result.ok, true);
  assert.deepEqual(roots, [['G:\\AI\\Codex\\xinshu']]);
});

test('用户中止挂起的 Codex 升级会停止升级进程并走失败回退', async () => {
  let releaseUpgrade;
  const upgradeChild = { pid: 404 };
  const calls = [];
  const harness = createHarness({
    codexUpgradeProcess: { getActiveChild: () => upgradeChild },
    stopChild: async (targetChild) => {
      calls.push(`stop:${targetChild.pid}`);
      if (targetChild === upgradeChild) releaseUpgrade(new Error('Codex 升级被信号 SIGTERM 终止'));
    },
    runCodexUpgrade: () => new Promise((_, reject) => { releaseUpgrade = reject; }),
    rollbackCodexUpgrade: async (version) => calls.push(`rollback:${version}`),
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codex', 'upgrade_and_restart'));
  const committed = harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codex', 'upgrade_and_restart'));
  await wait(10);
  const aborted = await harness.supervisor.handleEngineControlAbort(harness.backend, {
    channel: 'relay-engine-control-v1', type: 'engine_abort', operationId: 'engine-1', engineId: 'codex', action: 'upgrade_and_restart',
  });
  const result = await committed;
  assert.equal(aborted.ok, true);
  assert.deepEqual(calls, ['stop:203', 'stop:404', 'rollback:0.146.0']);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'upgrade_failed');
  assert.equal(harness.responses.at(-1).response.reason, 'upgrade_failed');
});

test('中止请求对应未知操作时拒绝并标记 operation_unknown', async () => {
  const harness = createHarness();
  const result = await harness.supervisor.handleEngineControlAbort(harness.backend, {
    channel: 'relay-engine-control-v1', type: 'engine_abort', operationId: 'missing', engineId: 'codex', action: 'upgrade_and_restart',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'operation_unknown');
  assert.equal(harness.responses.at(-1).response.reason, 'operation_unknown');
});

test('中止请求找不到活跃升级子进程时按 operation_unknown 拒绝', async () => {
  let releaseUpgrade;
  const harness = createHarness({
    codexUpgradeProcess: { getActiveChild: () => null },
    runCodexUpgrade: () => new Promise((_, reject) => { releaseUpgrade = reject; }),
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codex', 'upgrade_and_restart'));
  const committed = harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codex', 'upgrade_and_restart'));
  await wait(10);
  const result = await harness.supervisor.handleEngineControlAbort(harness.backend, {
    channel: 'relay-engine-control-v1', type: 'engine_abort', operationId: 'engine-1', engineId: 'codex', action: 'upgrade_and_restart',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'operation_unknown');
  releaseUpgrade(new Error('测试收尾：终止挂起的升级'));
  const terminal = await committed;
  assert.equal(terminal.reason, 'upgrade_failed');
});

test('无法确认 npm 来源时拒绝页面升级 Codex', async () => {
  const harness = createHarness({
    getCodexStatus: () => ({ version: '0.146.0', installSource: 'unknown', upgradeSupported: false, upgradeReason: '来源未知' }),
  });
  assert.deepEqual(await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codex', 'upgrade_and_restart')), {
    ok: false,
    reason: 'upgrade_unsupported',
  });
  assert.equal(harness.responses.at(-1).response.reason, 'upgrade_unsupported');
});

test('Git 冲突和依赖异常在启动器层阻断引擎维护', async () => {
  const conflict = createHarness({ inspectEnvironment: () => ({ dependenciesReady: true, conflictFiles: ['server/src/index.ts'] }) });
  assert.equal((await conflict.supervisor.handleEngineControlMessage(conflict.backend, engineMessage('codex', 'restart'))).reason, 'setup_blocked');
  assert.equal(conflict.responses.at(-1).response.reason, 'setup_blocked');

  const setup = createHarness({ inspectEnvironment: () => ({ dependenciesReady: false, conflictFiles: [] }) });
  assert.equal((await setup.supervisor.handleEngineControlMessage(setup.backend, engineMessage('codebuddy', 'upgrade'))).reason, 'setup_required');
  assert.equal(setup.responses.at(-1).response.reason, 'setup_required');
});

test('CodeBuddy 升级成功后必须通过 readiness', async () => {
  const calls = [];
  const harness = createHarness({
    runCodeBuddyUpgrade: async () => calls.push('upgrade'),
    runCodeBuddyReadiness: async () => calls.push('readiness'),
    refreshEngineSetupState: async (engineId, readinessOk) => calls.push(`refresh:${engineId}:${readinessOk}`),
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codebuddy', 'upgrade'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codebuddy', 'upgrade'));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['upgrade', 'readiness', 'refresh:codebuddy:true']);
  assert.deepEqual(harness.stopped, []);
});

test('OpenCode 升级请求在启动终端和进度中使用 OpenCode 名称', async () => {
  const stages = [];
  const harness = createHarness({
    getOpenCodeStatus: () => ({ version: '1.0.0', installSource: 'official_npm_global', upgradeSupported: true }),
    maintenanceOutputStore: {
      start() {}, append() {}, finish() {}, getSnapshot() { return null; },
      appendStage(_operationId, line) { stages.push(line); },
    },
  });
  const result = await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('opencode', 'upgrade'));
  assert.equal(result.ok, true);
  assert.ok(harness.output.some((line) => line.includes('收到用户 admin 的升级 OpenCode请求')));
  assert.ok(stages.includes('已接受升级 OpenCode请求'));
});

test('CodeBuddy 升级按 npm、readiness 和失败回退阶段报告', async () => {
  const stages = [];
  const outputStore = {
    start() {}, append() {}, finish() {}, getSnapshot() { return null; },
    appendStage(_operationId, line) { stages.push(line); },
  };
  const harness = createHarness({
    maintenanceOutputStore: outputStore,
    runCodeBuddyUpgrade: async () => {},
    runCodeBuddyReadiness: async () => { throw new Error('readiness failed'); },
    rollbackCodeBuddyUpgrade: async () => {},
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codebuddy', 'upgrade'));
  await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codebuddy', 'upgrade'));
  assert.ok(stages.indexOf('正在升级 CodeBuddy npm 包') < stages.indexOf('正在验证 CodeBuddy readiness'));
  assert.ok(stages.includes('正在回退 CodeBuddy'));
});

test('CodeBuddy 复验只运行 readiness 并刷新 setup state', async () => {
  const calls = [];
  const harness = createHarness({
    runCodeBuddyReadiness: async (mode) => calls.push(`readiness:${mode}`),
    refreshEngineSetupState: async (engineId, readinessOk) => calls.push(`refresh:${engineId}:${readinessOk}`),
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codebuddy', 'recheck'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codebuddy', 'recheck'));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['readiness:availability', 'refresh:codebuddy:true']);
});

test('CodeBuddy 复验失败时保存失败事实且不执行升级', async () => {
  const calls = [];
  const harness = createHarness({
    runCodeBuddyReadiness: async (mode) => { calls.push(`readiness:${mode}`); throw new Error('未登录'); },
    refreshEngineSetupState: async (engineId, readinessOk) => calls.push(`refresh:${engineId}:${readinessOk}`),
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codebuddy', 'recheck'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codebuddy', 'recheck'));
  assert.equal(result.reason, 'readiness_failed');
  assert.deepEqual(calls, ['readiness:availability']);
});

test('CodeBuddy 额度未恢复时重新检测保留持久阻断', async () => {
  const calls = [];
  const harness = createHarness({
    runCodeBuddyReadiness: async () => { calls.push('recheck'); throw Object.assign(new Error('quota'), { exitCode: 42 }); },
    refreshEngineSetupState: async (...args) => calls.push(`refresh:${args.join(':')}`),
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codebuddy', 'recheck'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codebuddy', 'recheck'));
  assert.equal(result.reason, 'quota_deferred');
  assert.deepEqual(calls, ['recheck', 'refresh:codebuddy:false:provider_quota']);
});

test('CodeBuddy 首次安装成功后等待用户登录，不立即执行 readiness', async () => {
  const calls = [];
  const harness = createHarness({
    getCodeBuddyStatus: () => ({ version: null, installSource: 'unknown', upgradeSupported: false, upgradeReason: '未安装' }),
    runCodeBuddyUpgrade: async () => calls.push('install'),
    runCodeBuddyReadiness: async () => { calls.push('readiness'); throw new Error('未登录'); },
    refreshEngineSetupState: async (engineId, readinessOk) => calls.push(`refresh:${engineId}:${readinessOk}`),
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codebuddy', 'install'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codebuddy', 'install'));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['install', 'refresh:codebuddy:false']);
  assert.deepEqual(harness.responses.map(({ response }) => response.status), ['accepted', 'completed']);
});

test('CodeBuddy readiness 失败时回退已记录旧版本并再次检查', async () => {
  const calls = [];
  const harness = createHarness({
    runCodeBuddyUpgrade: async () => calls.push('upgrade'),
    runCodeBuddyReadiness: async () => {
      calls.push('readiness');
      if (calls.filter((entry) => entry === 'readiness').length === 1) throw new Error('not ready');
    },
    rollbackCodeBuddyUpgrade: async (version) => calls.push(`rollback:${version}`),
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codebuddy', 'upgrade'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codebuddy', 'upgrade'));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'readiness_failed');
  assert.deepEqual(calls, ['upgrade', 'readiness', 'rollback:2.140.0', 'readiness']);
});

test('CodeBuddy 新版遇到额度 429 时保留安装并持久阻断会话', async () => {
  const calls = [];
  const harness = createHarness({
    runCodeBuddyUpgrade: async () => calls.push('upgrade'),
    runCodeBuddyReadiness: async () => { calls.push('readiness'); throw Object.assign(new Error('quota'), { exitCode: 42 }); },
    rollbackCodeBuddyUpgrade: async () => calls.push('rollback'),
    refreshEngineSetupState: async (...args) => calls.push(`refresh:${args.join(':')}`),
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codebuddy', 'upgrade'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codebuddy', 'upgrade'));
  assert.equal(result.reason, 'quota_deferred');
  assert.deepEqual(calls, ['upgrade', 'readiness', 'refresh:codebuddy:false:provider_quota']);
  assert.equal(harness.responses.at(-1).response.reason, 'quota_deferred');
});

test('CodeBuddy npm 安装失败即使退出码为 42 也不走额度延期', async () => {
  const calls = [];
  const harness = createHarness({
    runCodeBuddyUpgrade: async () => { calls.push('upgrade'); throw Object.assign(new Error('install failed'), { exitCode: 42 }); },
    rollbackCodeBuddyUpgrade: async () => calls.push('rollback'),
    runCodeBuddyReadiness: async () => calls.push('readiness'),
    refreshEngineSetupState: async () => calls.push('refresh'),
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codebuddy', 'upgrade'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codebuddy', 'upgrade'));
  assert.equal(result.reason, 'readiness_failed');
  assert.deepEqual(calls, ['upgrade', 'rollback', 'readiness']);
});

test('CodeBuddy 升级后安装来源验证失败时不进入 readiness 并回退', async () => {
  let checks = 0;
  const calls = [];
  const harness = createHarness({
    getCodeBuddyStatus: () => checks++ < 2
      ? { version: '2.140.0', installSource: 'npm_global', upgradeSupported: true, upgradeReason: null }
      : { version: '2.141.0', installSource: 'unknown', upgradeSupported: false, upgradeReason: '来源不一致' },
    runCodeBuddyUpgrade: async () => calls.push('upgrade'),
    runCodeBuddyReadiness: async () => calls.push('readiness'),
    rollbackCodeBuddyUpgrade: async (version) => calls.push(`rollback:${version}`),
  });
  await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codebuddy', 'upgrade'));
  const result = await harness.supervisor.handleEngineControlCommit(harness.backend, engineCommit('codebuddy', 'upgrade'));
  assert.equal(result.reason, 'readiness_failed');
  assert.deepEqual(calls, ['upgrade', 'rollback:2.140.0', 'readiness']);
});

test('服务与引擎控制共享全局破坏性操作互斥', async () => {
  const harness = createHarness();
  await harness.supervisor.handleControlMessage(harness.backend, message('frontend', 'service-op'));
  assert.deepEqual(await harness.supervisor.handleEngineControlMessage(harness.backend, engineMessage('codex', 'restart', 'engine-op')), {
    ok: false, reason: 'operation_in_progress',
  });
});

test('计划内退出可被监视器识别且同一时间只允许一个重启', async () => {
  let releaseStop;
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  const harness = createHarness({
    stopChild: async (targetChild) => {
      await stopGate;
      targetChild.exitCode = 0;
    },
  });
  await harness.supervisor.handleControlMessage(harness.backend, message('backend', 'op-1'));
  const first = harness.supervisor.handleControlCommit(harness.backend, commit('backend', 'op-1'));
  await Promise.resolve();
  assert.equal(harness.supervisor.isRestarting('backend'), true);
  assert.equal(harness.supervisor.shouldIgnoreExit(harness.backend), true);
  assert.deepEqual(await harness.supervisor.handleControlMessage(harness.backend, message('frontend', 'op-2')), {
    ok: false,
    reason: 'operation_in_progress',
  });
  assert.equal(harness.responses.at(-1).response.reason, 'operation_in_progress');
  releaseStop();
  assert.equal((await first).ok, true);
  assert.equal(harness.supervisor.isRestarting('backend'), false);
});

test('父启动器在后端替换后仍保留同目标 30 秒和跨目标 10 秒冷却', async () => {
  const harness = createHarness();
  await harness.supervisor.handleControlMessage(harness.backend, message('backend', 'op-1'));
  assert.equal((await harness.supervisor.handleControlCommit(harness.backend, commit('backend', 'op-1'))).ok, true);
  const nextBackend = harness.owned.get('backend').child;
  const limited = await harness.supervisor.handleControlMessage(nextBackend, message('frontend', 'op-2'));
  assert.deepEqual(limited, { ok: false, reason: 'rate_limited', retryAfterMs: 10_000 });
  assert.equal(harness.responses.at(-1).response.reason, 'rate_limited');
  harness.advance(10_000);
  assert.equal((await harness.supervisor.handleControlMessage(nextBackend, message('frontend', 'op-3'))).status, 'accepted');
});

test('连续重启同一目标需要等待 30 秒', async () => {
  const harness = createHarness();
  await harness.supervisor.handleControlMessage(harness.backend, message('frontend', 'op-1'));
  await harness.supervisor.handleControlCommit(harness.backend, commit('frontend', 'op-1'));
  assert.deepEqual(await harness.supervisor.handleControlMessage(harness.backend, message('frontend', 'op-2')), {
    ok: false,
    reason: 'rate_limited',
    retryAfterMs: 30_000,
  });
  harness.advance(30_000);
  assert.equal((await harness.supervisor.handleControlMessage(harness.backend, message('frontend', 'op-3'))).status, 'accepted');
});

test('状态查询只返回前后端各自的剩余冷却', async () => {
  const harness = createHarness();
  await harness.supervisor.handleControlMessage(harness.backend, message('backend', 'op-1'));
  await harness.supervisor.handleControlCommit(harness.backend, commit('backend', 'op-1'));
  const nextBackend = harness.owned.get('backend').child;
  const result = await harness.supervisor.handleStatusMessage(nextBackend, {
    channel: 'relay-control-v1', type: 'status_request', requestId: 'status-1',
  });
  assert.deepEqual(result, {
    ok: true,
    backendRetryAfterMs: 30_000,
    frontendRetryAfterMs: 10_000,
    operationInProgress: false,
  });
  assert.equal(harness.responses.at(-1).response.type, 'status_response');
});

test('运行状态查询与重启请求分开分发且只响应当前后端', async () => {
  const runtimeStatus = { frontendMode: 'production', activeBuildId: 'abcdef123456', activeBuildLabel: '20260809-1410 · abcdef1', frontendBuildRequired: true, frontendBuildReason: '前端源码较活动构建更新' };
  const harness = createHarness({ getRuntimeStatus: () => runtimeStatus });
  assert.deepEqual(await harness.supervisor.handleRuntimeStatusMessage(harness.backend, {
    channel: 'relay-control-v1', type: 'runtime_status_request', requestId: 'runtime-1',
  }), { ok: true, ...runtimeStatus });
  assert.equal(harness.responses.at(-1).response.type, 'runtime_status_response');
  assert.deepEqual(await harness.supervisor.handleRuntimeStatusMessage(child(999), {
    channel: 'relay-control-v1', type: 'runtime_status_request', requestId: 'runtime-2',
  }), { ok: false, reason: 'untrusted_source' });
});

test('运行状态计算失败时返回受限降级状态', async () => {
  const production = createHarness({
    frontendMode: 'production',
    getRuntimeStatus: () => { throw new Error('状态文件损坏'); },
  });
  const productionResult = await production.supervisor.handleRuntimeStatusMessage(production.backend, {
    channel: 'relay-control-v1', type: 'runtime_status_request', requestId: 'runtime-failed-production',
  });
  assert.deepEqual(productionResult, {
    ok: true,
    frontendMode: 'production',
    activeBuildId: null,
    activeBuildLabel: null,
    frontendBuildRequired: true,
    frontendBuildReason: '无法检查生产构建状态',
  });
  assert.match(production.errors.join('\n'), /读取前端运行状态失败/);

  const development = createHarness({
    frontendMode: 'development',
    getRuntimeStatus: async () => { throw new Error('状态不可用'); },
  });
  const developmentResult = await development.supervisor.handleRuntimeStatusMessage(development.backend, {
    channel: 'relay-control-v1', type: 'runtime_status_request', requestId: 'runtime-failed-development',
  });
  assert.deepEqual(developmentResult, {
    ok: true,
    frontendMode: 'development',
    activeBuildId: null,
    activeBuildLabel: null,
    frontendBuildRequired: false,
    frontendBuildReason: null,
  });
});

test('production 构建失败时不停止旧前端', async () => {
  const harness = createHarness({
    frontendMode: 'production',
    prepareFrontend: () => { throw new Error('构建失败'); },
    switchFrontendRelease: async () => { throw new Error('不应切换'); },
    resolveFrontendService: () => services.get('frontend'),
  });
  await harness.supervisor.handleControlMessage(harness.backend, message('frontend'));
  const result = await harness.supervisor.handleControlCommit(harness.backend, commit('frontend'));
  assert.equal(result.ok, false);
  assert.deepEqual(harness.stopped, []);
  assert.equal(harness.owned.get('frontend').child, harness.frontend);
});

test('production 异步构建完成前保持旧前端运行且仍可响应输出查询', async () => {
  let finishBuild;
  const harness = createHarness({
    frontendMode: 'production',
    prepareFrontend: () => new Promise((resolve) => { finishBuild = resolve; }),
    switchFrontendRelease: async ({ startGateway }) => ({ status: 'switched', buildId: 'abcdef123456', gateway: await startGateway('abcdef123456', 'release') }),
    resolveFrontendService: () => services.get('frontend'),
  });
  await harness.supervisor.handleControlMessage(harness.backend, message('frontend', 'async-build'));
  const commitPromise = harness.supervisor.handleControlCommit(harness.backend, commit('frontend', 'async-build'));
  await Promise.resolve();
  assert.deepEqual(harness.stopped, []);
  assert.equal(harness.owned.get('frontend').child, harness.frontend);
  const output = await harness.supervisor.handleMaintenanceOutputMessage(harness.backend, {
    channel: 'relay-maintenance-output-v1', type: 'output_status_request', requestId: 'during-build', operationId: 'async-build',
  });
  assert.equal(output.output?.status, 'running');
  finishBuild({ buildId: 'abcdef123456' });
  const result = await commitPromise;
  assert.equal(result.ok, true);
  assert.deepEqual(harness.stopped, [202]);
});

test('production 新网关失败后恢复 previous 并报告本次重启失败', async () => {
  const harness = createHarness({
    frontendMode: 'production',
    root: 'G:/relay-test',
    prepareFrontend: () => {},
    resolveFrontendService: () => services.get('frontend'),
    switchFrontendRelease: async ({ startGateway }) => {
      const restored = await startGateway('abcdef123456', 'release');
      return { status: 'rolled_back', buildId: 'abcdef123456', gateway: restored, error: new Error('新网关失败') };
    },
    getFrontendBuildLabel: (buildId) => buildId === 'abcdef123456' ? '20260809-1410 · abcdef1' : null,
  });
  await harness.supervisor.handleControlMessage(harness.backend, message('frontend'));
  const result = await harness.supervisor.handleControlCommit(harness.backend, commit('frontend'));
  assert.equal(result.ok, false);
  assert.deepEqual(harness.stopped, [202]);
  assert.equal(harness.owned.has('frontend'), true);
  assert.match(harness.errors.join('\n'), /已恢复构建 20260809-1410 · abcdef1/);
});

test('页面触发的不同操作之间输出空行且日志带月日时间', async () => {
  const harness = createHarness();
  await harness.supervisor.handleControlMessage(harness.backend, message('frontend', 'op-1'));
  await harness.supervisor.handleControlCommit(harness.backend, commit('frontend', 'op-1'));
  harness.advance(10_000);
  await harness.supervisor.handleControlMessage(harness.backend, message('backend', 'op-2'));
  assert.match(harness.output[0], /^\[08-06 09:02:03\] 收到管理员/);
  assert.equal(harness.output.filter((line) => line === '').length, 1);
});

test('旧页面 setup 目标被协议层拒绝且不会触发服务变更', async () => {
  const harness = createHarness();
  const setupMessage = message('setup', 'setup-removed');
  const setupCommit = commit('setup', 'setup-removed');

  assert.deepEqual(await harness.supervisor.handleControlMessage(harness.backend, setupMessage), {
    ok: false,
    reason: 'invalid_message',
  });
  assert.deepEqual(await harness.supervisor.handleControlCommit(harness.backend, setupCommit), {
    ok: false,
    reason: 'invalid_message',
  });
  assert.deepEqual(harness.stopped, []);
  assert.deepEqual(harness.spawned, []);
  assert.equal(harness.owned.get('backend')?.child, harness.backend);
  assert.equal(harness.owned.get('frontend')?.child, harness.frontend);
});

test('production 完整 Relay 重启先准备前端 release，再启动 helper 并安排旧启动器退出', async () => {
  const calls = [];
  let replacementOptions = null;
  const harness = createHarness({
    frontendMode: 'production',
    validateRelayRestart: () => calls.push('validate'),
    prepareFrontend: () => { calls.push('prepare'); return { buildId: 'abcdef123456' }; },
    spawnLauncherRestartHelper: (options) => { replacementOptions = options; calls.push('helper'); return { pid: 404 }; },
    scheduleLauncherShutdown: () => calls.push('shutdown'),
  });
  await harness.supervisor.handleControlMessage(harness.backend, message('relay', 'relay-op'));
  const result = await harness.supervisor.handleControlCommit(harness.backend, commit('relay', 'relay-op'));
  assert.deepEqual(calls, ['validate', 'prepare', 'helper', 'shutdown']);
  assert.deepEqual(replacementOptions, { preparedBuildId: 'abcdef123456' });
  assert.equal(result.ok, true);
  assert.equal(result.helperPid, 404);
  assert.deepEqual(harness.stopped, []);
});

test('production 完整 Relay 重启前端准备失败时不启动 helper、不关闭旧服务', async () => {
  const calls = [];
  const harness = createHarness({
    frontendMode: 'production',
    validateRelayRestart: () => calls.push('validate'),
    prepareFrontend: () => { calls.push('prepare'); throw new Error('超出 JavaScript 总量预算'); },
    spawnLauncherRestartHelper: () => { calls.push('helper'); return { pid: 404 }; },
    scheduleLauncherShutdown: () => calls.push('shutdown'),
  });
  await harness.supervisor.handleControlMessage(harness.backend, message('relay', 'relay-build-failed'));
  const result = await harness.supervisor.handleControlCommit(harness.backend, commit('relay', 'relay-build-failed'));
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['validate', 'prepare']);
  assert.deepEqual(harness.stopped, []);
  assert.equal(harness.owned.get('backend').child, harness.backend);
  assert.equal(harness.owned.get('frontend').child, harness.frontend);
  assert.match(harness.errors.join('\n'), /超出 JavaScript 总量预算/);
  assert.match(harness.responses.at(-1).response.message, /完整重启已取消，现有服务仍在运行/);
});

test('完整 Relay 重启 helper 启动失败时保留当前服务', async () => {
  const harness = createHarness({ spawnLauncherRestartHelper: () => { throw new Error('helper 启动失败'); } });
  await harness.supervisor.handleControlMessage(harness.backend, message('relay', 'relay-failed'));
  const result = await harness.supervisor.handleControlCommit(harness.backend, commit('relay', 'relay-failed'));
  assert.equal(result.ok, false);
  assert.deepEqual(harness.stopped, []);
  assert.equal(harness.owned.get('backend').child, harness.backend);
});

test('完整 Relay 重启环境预检失败时不启动 helper 且保留当前服务', async () => {
  let helperStarted = false;
  const harness = createHarness({
    validateRelayRestart: () => { throw new Error('Relay 尚未完成初始化'); },
    spawnLauncherRestartHelper: () => { helperStarted = true; return { pid: 404 }; },
  });
  await harness.supervisor.handleControlMessage(harness.backend, message('relay', 'relay-preflight-failed'));
  const result = await harness.supervisor.handleControlCommit(harness.backend, commit('relay', 'relay-preflight-failed'));
  assert.equal(result.ok, false);
  assert.equal(helperStarted, false);
  assert.deepEqual(harness.stopped, []);
  assert.equal(harness.owned.get('backend').child, harness.backend);
  assert.equal(harness.owned.get('frontend').child, harness.frontend);
});

test('健康检查失败时清理失败目标并保留其他服务', async () => {
  const harness = createHarness({
    waitForReady: async () => { throw new Error('启动超时'); },
  });
  await harness.supervisor.handleControlMessage(harness.backend, message('backend'));
  const result = await harness.supervisor.handleControlCommit(harness.backend, commit('backend'));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'restart_failed');
  assert.equal(harness.owned.has('backend'), false);
  assert.equal(harness.owned.get('frontend').child, harness.frontend);
  assert.deepEqual(harness.stopped, [101, 300]);
  assert.match(harness.errors.join('\n'), /启动超时/);
});

test('目标启动依赖缺失时保留当前服务且不尝试替换', async () => {
  const harness = createHarness({
    validateBeforeRestart: () => { throw new Error('Relay 尚未完成初始化，请先运行 npm run setup'); },
  });
  await harness.supervisor.handleControlMessage(harness.backend, message('frontend'));
  const result = await harness.supervisor.handleControlCommit(harness.backend, commit('frontend'));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'restart_failed');
  assert.equal(harness.owned.get('frontend').child, harness.frontend);
  assert.deepEqual(harness.stopped, []);
  assert.deepEqual(harness.spawned, []);
  assert.match(harness.errors.join('\n'), /尚未完成初始化/);
});

test('接受回执无法发送时不停止任何服务', async () => {
  const harness = createHarness({ sendControlResponse: async () => false });
  assert.deepEqual(await harness.supervisor.handleControlMessage(harness.backend, message('backend')), {
    ok: false,
    reason: 'response_unavailable',
  });
  assert.deepEqual(harness.stopped, []);
});

test('只有 operationId 与 target 同时匹配才执行已接受的恢复', async () => {
  const harness = createHarness();
  await harness.supervisor.handleControlMessage(harness.backend, message('backend', 'op-bound'));
  assert.deepEqual(await harness.supervisor.handleControlCommit(harness.backend, commit('frontend', 'op-bound')), {
    ok: false,
    reason: 'operation_mismatch',
  });
  assert.deepEqual(harness.stopped, []);
  assert.equal((await harness.supervisor.handleControlCommit(harness.backend, commit('backend', 'op-bound'))).ok, true);
});

test('浏览器未确认时预留会自动过期且不会停止服务', async () => {
  const harness = createHarness({ reservationTimeoutMs: 5 });
  assert.equal((await harness.supervisor.handleControlMessage(harness.backend, message('backend', 'op-expire'))).status, 'accepted');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(harness.supervisor.getActiveRestart(), null);
  assert.deepEqual(harness.stopped, []);
});

test('只接受当前受托管 backend 子进程发出的控制消息', async () => {
  const harness = createHarness();
  assert.deepEqual(await harness.supervisor.handleControlMessage(child(999), message()), {
    ok: false,
    reason: 'untrusted_source',
  });
  assert.deepEqual(await harness.supervisor.handleControlMessage(harness.backend, { command: 'npm restart' }), {
    ok: false,
    reason: 'invalid_message',
  });
  assert.deepEqual(harness.stopped, []);
});
