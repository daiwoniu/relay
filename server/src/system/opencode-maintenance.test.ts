import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenCodeMaintenanceAdapter } from './opencode-maintenance.js';

test('OpenCode CLI 已安装但 setup state 没有版本时维护面板不显示未安装', async () => {
  const status = await new OpenCodeMaintenanceAdapter({
    getStatus: async () => ({
      cliInstalled: true,
      installedVersion: null,
      installSource: 'unknown',
      readiness: 'ready',
      readinessCheckedAt: null,
      installedAt: null,
      availabilityStage: 'ready',
    }),
    fetchLatestVersion: async () => ({ version: '1.18.31', publishedAt: null }),
  }).getStatus();
  assert.equal(status.installedVersion, null);
  assert.equal(status.availabilityStage, 'ready');
  assert.match(status.statusMessage || '', /已安装/);
  assert.equal(/未检测到/.test(status.statusMessage || ''), false);
});

test('OpenCode 检查 npm registry 后返回最新版本与更新状态', async () => {
  const adapter = new OpenCodeMaintenanceAdapter({
    getStatus: async () => ({
      cliInstalled: true, installedVersion: '1.18.31', installSource: 'official_npm_global',
      readiness: 'ready', readinessCheckedAt: 1, installedAt: 1_700_000_000_000, availabilityStage: 'ready',
    }),
    fetchLatestVersion: async () => ({ version: '1.19.0', publishedAt: 1_700_000_000_000 }),
  });
  const status = await adapter.checkLatest();
  assert.equal(status.latestVersion, '1.19.0');
  assert.equal(status.updateAvailable, true);
  assert.equal(status.latestCheckStatus, 'success');
  assert.equal(typeof status.latestCheckedAt, 'number');
});
