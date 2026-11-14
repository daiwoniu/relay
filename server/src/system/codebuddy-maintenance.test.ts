import assert from 'node:assert/strict';
import test from 'node:test';
import { CodeBuddyMaintenanceAdapter } from './codebuddy-maintenance.js';

const version = {
  installedVersion: '2.140.0', latestVersion: '2.141.0', updateAvailable: true,
  status: 'success' as const, checkedAt: 10,
  releaseOverview: {
    sourceStatus: 'available' as const,
    counts: { features: 1, improvements: 2, fixes: 3, documentation: 0, chores: 0 },
    topics: ['tasks_sessions' as const],
    officialSource: 'codebuddy_cnb' as const,
    officialUrl: 'https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/release-notes/v2.141.0.md',
  },
  releasePublishedAt: null,
};

test('CodeBuddy 活动实例阻断升级并保留实例启动版本分布', async () => {
  const adapter = new CodeBuddyMaintenanceAdapter({
    getVersionSnapshot: () => version,
    checkLatestVersion: async () => ({ ...version, checkedAt: 20 }),
    readInstallSource: () => 'official_npm_global',
    readInstanceSummary: () => ({ activeInstanceCount: 3, versions: [{ version: '2.140.0', count: 2 }, { version: null, count: 1 }] }),
    readReadiness: () => ({ readiness: 'ready', checkedAt: 5 }),
  });
  const status = await adapter.getStatus();
  assert.equal(status.actions.length, 2);
  assert.equal(status.actions.find((action) => action.action === 'recheck')?.enabled, false);
  assert.equal(status.actions.find((action) => action.action === 'upgrade')?.enabled, false);
  assert.deepEqual(status.instanceVersions, [{ version: '2.140.0', count: 2 }, { version: null, count: 1 }]);
  assert.equal((await adapter.checkLatest()).latestCheckedAt, 20);
});

test('CodeBuddy 无活动实例且存在官方新版时允许升级', async () => {
  const adapter = new CodeBuddyMaintenanceAdapter({
    getVersionSnapshot: () => version,
    checkLatestVersion: async () => version,
    readInstallSource: () => 'official_npm_global',
    readInstanceSummary: () => ({ activeInstanceCount: 0, versions: [] }),
    readReadiness: () => ({ readiness: 'stale', checkedAt: 5 }),
  });
  const status = await adapter.getStatus();
  assert.equal(status.availabilityStage, 'readiness_stale');
  assert.equal(status.loginCommand, null);
  assert.equal(status.actions.find((action) => action.action === 'recheck')?.enabled, true);
  assert.equal(status.actions.find((action) => action.action === 'upgrade')?.enabled, true);
  assert.equal(status.recommendedAction, 'upgrade');
  assert.deepEqual(status.releaseOverview, version.releaseOverview);
});

test('CodeBuddy readiness 失败时保持升级入口禁用', async () => {
  const adapter = new CodeBuddyMaintenanceAdapter({
    getVersionSnapshot: () => version,
    checkLatestVersion: async () => version,
    readInstallSource: () => 'official_npm_global',
    readInstanceSummary: () => ({ activeInstanceCount: 0, versions: [] }),
    readReadiness: () => ({ readiness: 'failed', checkedAt: 5 }),
  });
  const status = await adapter.getStatus();
  const upgrade = status.actions.find((action) => action.action === 'upgrade');
  assert.equal(upgrade?.enabled, false);
  assert.match(upgrade?.reason || '', /readiness 失败/);
});

test('CodeBuddy 额度延期时面板说明原因并开放重新检测', async () => {
  const adapter = new CodeBuddyMaintenanceAdapter({
    getVersionSnapshot: () => ({ ...version, installedVersion: '2.141.0', updateAvailable: false }),
    checkLatestVersion: async () => version,
    readInstallSource: () => 'official_npm_global',
    readInstanceSummary: () => ({ activeInstanceCount: 0, versions: [] }),
    readReadiness: () => ({
      readiness: 'failed', checkedAt: null, availabilityStage: 'readiness_failed',
      message: 'CodeBuddy 模型额度已用尽，恢复额度后请重新检测',
    }),
  });
  const status = await adapter.getStatus();
  assert.match(status.statusMessage || '', /额度已用尽/);
  assert.equal(status.loginCommand, null);
  assert.equal(status.actions.find((action) => action.action === 'recheck')?.enabled, true);
  assert.equal(status.actions.find((action) => action.action === 'upgrade')?.enabled, false);
  assert.match(status.actions.find((action) => action.action === 'upgrade')?.reason || '', /额度已用尽/);
});

test('CodeBuddy 只有结构化认证缺失才显示登录命令', async () => {
  const create = (availabilityStage: 'installed_auth_required' | 'readiness_failed') => new CodeBuddyMaintenanceAdapter({
    getVersionSnapshot: () => version,
    checkLatestVersion: async () => version,
    readInstallSource: () => 'official_npm_global',
    readInstanceSummary: () => ({ activeInstanceCount: 0, versions: [] }),
    readReadiness: () => ({ readiness: 'failed', checkedAt: 5, availabilityStage }),
  });
  assert.equal((await create('installed_auth_required').getStatus()).loginCommand, 'codebuddy');
  assert.equal((await create('readiness_failed').getStatus()).loginCommand, null);
});
