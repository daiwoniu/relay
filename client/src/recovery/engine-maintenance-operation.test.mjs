import assert from 'node:assert/strict';
import test from 'node:test';
import { pollEngineMaintenanceOperation } from './engine-maintenance-operation.ts';
import * as maintenanceRecovery from './engine-maintenance-operation.ts';

const operation = (status) => ({
  operationId: 'op-1', engineId: 'codex', action: 'restart', status,
  message: status === 'completed' ? '完成' : '处理中', retryAfterMs: 0, output: null,
});

test('引擎维护轮询逐次投影成功响应并把短暂断联单独上报', async () => {
  let now = 0;
  let calls = 0;
  const observed = [];
  let disconnected = 0;
  await pollEngineMaintenanceOperation({
    probe: async () => { calls += 1; if (calls === 1) throw new Error('offline'); return operation('completed'); },
    onOperation: (next) => observed.push(next.status),
    onDisconnected: () => { disconnected += 1; },
    wait: async (milliseconds) => { now += milliseconds; }, now: () => now, intervalMs: 10, timeoutMs: 100,
  });
  assert.deepEqual(observed, ['completed']);
  assert.equal(disconnected, 1);
});

test('引擎维护轮询等待权威终态而不是固定延迟刷新一次', async () => {
  let now = 0;
  let calls = 0;
  const result = await pollEngineMaintenanceOperation({
    probe: async () => operation(++calls < 3 ? 'processing' : 'completed'),
    wait: async (milliseconds) => { now += milliseconds; },
    now: () => now,
    intervalMs: 100,
    timeoutMs: 1_000,
  });
  assert.equal(result?.status, 'completed');
  assert.equal(calls, 3);
});

test('引擎维护轮询有明确超时且不会无限等待', async () => {
  let now = 0;
  const result = await pollEngineMaintenanceOperation({
    probe: async () => operation('processing'),
    wait: async (milliseconds) => { now += milliseconds; },
    now: () => now,
    intervalMs: 100,
    timeoutMs: 250,
  });
  assert.equal(result, null);
});

test('维护操作 ID 在同一浏览器标签刷新后按账号和引擎恢复', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  assert.equal(typeof maintenanceRecovery.rememberEngineMaintenanceOperation, 'function');
  maintenanceRecovery.rememberEngineMaintenanceOperation(storage, 'admin-1', {
    ...operation('processing'), operationId: 'op-open-1', engineId: 'opencode', action: 'upgrade',
  });
  assert.deepEqual(JSON.parse(values.get('relay:engine-maintenance:admin-1:opencode')), {
    operationId: 'op-open-1', engineId: 'opencode', action: 'upgrade',
  });
  assert.deepEqual(maintenanceRecovery.readRememberedEngineMaintenanceOperation(storage, 'admin-1', 'opencode'), {
    operationId: 'op-open-1', engineId: 'opencode', action: 'upgrade',
  });
  assert.equal(maintenanceRecovery.readRememberedEngineMaintenanceOperation(storage, 'admin-2', 'opencode'), null);
  assert.equal(maintenanceRecovery.readRememberedEngineMaintenanceOperation(storage, 'admin-1', 'codebuddy'), null);
  maintenanceRecovery.forgetEngineMaintenanceOperation(storage, 'admin-1', 'opencode');
  assert.equal(maintenanceRecovery.readRememberedEngineMaintenanceOperation(storage, 'admin-1', 'opencode'), null);
});

test('重新打开维护面板时查询权威终态并丢弃过期操作', async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  maintenanceRecovery.rememberEngineMaintenanceOperation(storage, 'admin-1', {
    operationId: 'op-open-1', engineId: 'opencode', action: 'upgrade',
  });
  assert.equal(typeof maintenanceRecovery.recoverRememberedEngineMaintenanceOperation, 'function');
  const completed = { ...operation('completed'), operationId: 'op-open-1', engineId: 'opencode', action: 'upgrade' };
  assert.deepEqual(await maintenanceRecovery.recoverRememberedEngineMaintenanceOperation({
    storage, userId: 'admin-1', engineId: 'opencode', probe: async () => completed,
  }), completed);
  assert.equal(await maintenanceRecovery.recoverRememberedEngineMaintenanceOperation({
    storage, userId: 'admin-1', engineId: 'opencode', probe: async () => { throw { status: 404 }; },
  }), null);
  assert.equal(maintenanceRecovery.readRememberedEngineMaintenanceOperation(storage, 'admin-1', 'opencode'), null);
});
