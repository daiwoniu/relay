import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineMaintenanceRegistry } from '../engine/maintenance-registry.js';
import type { EngineMaintenanceAdapter } from '../engine/maintenance.js';
import { createEngineMaintenanceService } from '../system/engine-maintenance.js';
import { createEngineMaintenanceRouter } from './engine-maintenance.js';

const adapter: EngineMaintenanceAdapter = {
  id: 'codebuddy',
  async getStatus() { return { engineId: 'codebuddy', label: 'CodeBuddy', installedVersion: '2.0.0', installedAt: 1_000_000_000_000, runningVersion: null, latestVersion: '2.1.0', releaseOverview: null, updateAvailable: true, latestCheckStatus: 'success', latestCheckedAt: 1, installSource: 'official_npm_global', activeTaskCount: 0, activeInstanceCount: 0, instanceVersions: [], readiness: 'ready', readinessCheckedAt: 1, recommendedAction: 'upgrade', actions: [{ action: 'upgrade', label: '升级', enabled: true, reason: null, interruptsActiveTasks: false }] }; },
  async checkLatest() { return this.getStatus(); },
};
const codexAdapter: EngineMaintenanceAdapter = {
  id: 'codex',
  async getStatus() { return { engineId: 'codex', label: 'Codex', installedVersion: '1.0.0', installedAt: 1_000_000_000_000, runningVersion: '1.0.0', latestVersion: '1.0.0', releaseOverview: null, updateAvailable: false, latestCheckStatus: 'success', latestCheckedAt: 1, installSource: 'official_npm_global', activeTaskCount: 0, activeInstanceCount: 1, instanceVersions: [{ version: '1.0.0', count: 1 }], readiness: 'ready', readinessCheckedAt: 1, recommendedAction: null, actions: [{ action: 'restart', label: '重启', enabled: true, reason: null, interruptsActiveTasks: false }] }; },
  async checkLatest() { return this.getStatus(); },
};

test('引擎维护状态登录可读、操作仅管理员且请求字段严格', async () => {
  const service = createEngineMaintenanceService({ registry: new EngineMaintenanceRegistry([codexAdapter, adapter]), isLauncherManaged: () => true, send: () => true, commit: () => true, createOperationId: () => 'op-1' });
  const member = { id: '1', username: 'member', role: 'member' as const };
  const app = createEngineMaintenanceRouter({ service, authenticate: (cookie) => cookie === 'admin' ? { ...member, role: 'admin' } : cookie === 'member' ? member : null, isOriginAllowed: () => true });
  assert.equal((await app.request('/engine-maintenance', { headers: { cookie: 'member' } })).status, 200);
  assert.equal((await app.request('/engine-maintenance/reserve', { method: 'POST', headers: { cookie: 'member', origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ engineId: 'codebuddy', action: 'upgrade' }) })).status, 403);
  assert.equal((await app.request('/engine-maintenance/reserve', { method: 'POST', headers: { cookie: 'admin', origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ engineId: 'codebuddy', action: 'upgrade', packageName: 'evil' }) })).status, 400);
  assert.equal((await app.request('/engine-maintenance/reserve', { method: 'POST', headers: { cookie: 'admin', origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ engineId: 'codebuddy', action: 'upgrade' }) })).status, 202);
  assert.equal((await app.request('/engine-maintenance/operations/op-1', { headers: { cookie: 'admin' } })).status, 200);
  assert.equal((await app.request('/engine-maintenance/operations/missing', { headers: { cookie: 'admin' } })).status, 404);
});

test('普通登录用户只可执行 CodeBuddy 轻量复验', async () => {
  const recheckAdapter: EngineMaintenanceAdapter = {
    ...adapter,
    async getStatus() {
      return {
        ...(await adapter.getStatus()), readiness: 'stale' as const, availabilityStage: 'readiness_stale' as const,
        recommendedAction: null,
        actions: [{ action: 'recheck' as const, label: '重新检测', enabled: true, reason: null, interruptsActiveTasks: false }],
      };
    },
  };
  const service = createEngineMaintenanceService({ registry: new EngineMaintenanceRegistry([codexAdapter, recheckAdapter]), isLauncherManaged: () => true, send: () => true, commit: () => true, createOperationId: () => 'recheck-1' });
  const member = { id: '1', username: 'member', role: 'member' as const };
  const app = createEngineMaintenanceRouter({ service, authenticate: () => member, isOriginAllowed: () => true });
  const headers = { cookie: 'member', origin: 'http://localhost', 'content-type': 'application/json' };
  assert.equal((await app.request('/engine-maintenance/reserve', { method: 'POST', headers, body: JSON.stringify({ engineId: 'codebuddy', action: 'recheck' }) })).status, 202);
  assert.equal((await app.request('/engine-maintenance/confirm', { method: 'POST', headers, body: JSON.stringify({ operationId: 'recheck-1', engineId: 'codebuddy', action: 'recheck' }) })).status, 202);
});

test('引擎维护 operation 合并启动器输出快照', async () => {
  const output = { operationId: 'op-1', sequence: 1, lines: ['npm install...'], status: 'running' as const, updatedAt: 123 };
  const service = createEngineMaintenanceService({
    registry: new EngineMaintenanceRegistry([codexAdapter, adapter]), isLauncherManaged: () => true,
    send: () => true, commit: () => true, createOperationId: () => 'op-1', getOperationOutput: async () => output,
  });
  const app = createEngineMaintenanceRouter({ service, authenticate: () => ({ id: '1', username: 'admin', role: 'admin' }), isOriginAllowed: () => true });
  await app.request('/engine-maintenance/reserve', { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ engineId: 'codex', action: 'restart' }) });
  const response = await app.request('/engine-maintenance/operations/op-1');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).output, output);
});
