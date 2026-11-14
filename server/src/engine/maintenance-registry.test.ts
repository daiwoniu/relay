import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineMaintenanceAdapter } from './maintenance.js';
import { EngineMaintenanceError } from './maintenance.js';
import { EngineMaintenanceRegistry } from './maintenance-registry.js';

function adapter(id: 'codex' | 'codebuddy', version: string): EngineMaintenanceAdapter {
  const status = {
    engineId: id,
    label: id === 'codex' ? 'Codex' : 'CodeBuddy',
    installedVersion: version,
    runningVersion: null,
    latestVersion: version,
    releaseOverview: null,
    updateAvailable: false,
    latestCheckStatus: 'success' as const,
    latestCheckedAt: 1,
    installSource: 'official_npm_global' as const,
    activeTaskCount: 0,
    installedAt: 1_000_000_000_000,
    activeInstanceCount: 0,
    instanceVersions: [],
    readiness: 'ready' as const,
    readinessCheckedAt: 1,
    recommendedAction: null,
    actions: [],
  };
  return {
    id,
    async getStatus() { return status; },
    async checkLatest() { return { ...status, latestCheckedAt: 2 }; },
  };
}

test('Registry 按注册顺序聚合引擎状态并路由最新版检查', async () => {
  const registry = new EngineMaintenanceRegistry([adapter('codex', '1.0.0'), adapter('codebuddy', '2.0.0')]);
  assert.deepEqual((await registry.getSnapshot()).engines.map((entry) => entry.engineId), ['codex', 'codebuddy']);
  assert.equal((await registry.checkLatest('codebuddy')).latestCheckedAt, 2);
});

test('Registry 拒绝重复适配器和未注册引擎', () => {
  assert.throws(
    () => new EngineMaintenanceRegistry([adapter('codex', '1.0.0'), adapter('codex', '1.0.1')]),
    (error: unknown) => error instanceof EngineMaintenanceError && error.code === 'ENGINE_MAINTENANCE_DUPLICATE',
  );
  const registry = new EngineMaintenanceRegistry([adapter('codex', '1.0.0')]);
  assert.throws(
    () => registry.get('codebuddy'),
    (error: unknown) => error instanceof EngineMaintenanceError && error.code === 'ENGINE_MAINTENANCE_NOT_FOUND',
  );
});

test('Registry 单个适配器读取失败时保留其他引擎状态', async () => {
  const broken: EngineMaintenanceAdapter = {
    id: 'codebuddy',
    async getStatus() { throw new Error('adapter offline'); },
    async checkLatest() { throw new Error('latest offline'); },
  };
  const registry = new EngineMaintenanceRegistry([adapter('codex', '1.0.0'), broken]);

  const snapshot = await registry.getSnapshot();
  assert.deepEqual(snapshot.engines.map((entry) => entry.engineId), ['codex', 'codebuddy']);
  const failed = snapshot.engines.find((entry) => entry.engineId === 'codebuddy');
  assert.equal(failed?.latestCheckStatus, 'error');
  assert.equal(failed?.actions.every((action) => action.enabled === false), true);
});

test('Registry 单个引擎最新版检查失败时只返回该引擎错误状态', async () => {
  const broken: EngineMaintenanceAdapter = {
    id: 'codebuddy',
    async getStatus() { return adapter('codebuddy', '2.0.0').getStatus(); },
    async checkLatest() { throw new Error('latest offline'); },
  };
  const registry = new EngineMaintenanceRegistry([adapter('codex', '1.0.0'), broken]);

  const failed = await registry.checkLatest('codebuddy');
  assert.equal(failed.engineId, 'codebuddy');
  assert.equal(failed.latestCheckStatus, 'error');
  assert.equal(failed.actions.every((action) => action.enabled === false), true);
});
