import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexMaintenanceAdapter } from './codex-maintenance.js';

const version = {
  currentVersion: '0.146.0', latestVersion: '0.147.0', updateAvailable: true,
  releaseOverview: null,
  status: 'success' as const, checkedAt: 10,
};

test('Codex 活动任务只阻断升级，普通重启保留危险标记', async () => {
  const adapter = new CodexMaintenanceAdapter({
    getVersionSnapshot: () => version,
    checkLatestVersion: async () => ({ ...version, checkedAt: 20 }),
    readRunningVersion: () => '0.146.0',
    readActiveTaskCount: () => 2,
    readInstallSource: () => 'official_npm_global',
    readReadiness: () => ({ readiness: 'ready', checkedAt: 5 }),
  });
  const status = await adapter.getStatus();
  assert.deepEqual(status.instanceVersions, [{ version: '0.146.0', count: 1 }]);
  assert.deepEqual(status.actions.map(({ action, enabled, interruptsActiveTasks }) => ({ action, enabled, interruptsActiveTasks })), [
    { action: 'restart', enabled: true, interruptsActiveTasks: true },
    { action: 'upgrade_and_restart', enabled: false, interruptsActiveTasks: false },
  ]);
  assert.equal((await adapter.checkLatest()).latestCheckedAt, 20);
});

test('Codex 仅允许确认的官方 npm 全局安装升级', async () => {
  const adapter = new CodexMaintenanceAdapter({
    getVersionSnapshot: () => version,
    checkLatestVersion: async () => version,
    readRunningVersion: () => null,
    readActiveTaskCount: () => 0,
    readInstallSource: () => 'unknown',
    readReadiness: () => ({ readiness: 'failed', checkedAt: null }),
  });
  const status = await adapter.getStatus();
  assert.equal(status.actions.find((action) => action.action === 'upgrade_and_restart')?.enabled, false);
  assert.equal(status.actions.find((action) => action.action === 'restart')?.enabled, false);
});
