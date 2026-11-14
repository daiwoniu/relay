import assert from 'node:assert/strict';
import test from 'node:test';
import { ZcodeMaintenanceAdapter } from './zcode-maintenance.js';
import type { ZcodeMaintenanceDependencies } from './zcode-maintenance.js';

function makeAdapter(overrides: ZcodeMaintenanceDependencies = {}) {
  return new ZcodeMaintenanceAdapter({
    resolveEntry: () => 'C:/Program Files/ZCode/resources/glm/zcode.cjs',
    readProcessLive: () => false,
    ...overrides,
  });
}

test('readDesktopVersion 注入值直接作为已安装版本', async () => {
  const adapter = makeAdapter({ readDesktopVersion: () => '3.13.0' });
  const status = await adapter.getStatus();
  assert.equal(status.installedVersion, '3.13.0');
  assert.equal(status.installSource, 'desktop');
});

test('checkLatest 刷新最新版本并计算 updateAvailable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    '<span>Release v3.14.0</span><span>发布于 2026年9月19日</span>',
    { status: 200 },
  ) as Response) as typeof fetch;
  try {
    const adapter = makeAdapter({ readDesktopVersion: () => '3.13.0' });
    const status = await adapter.checkLatest();
    assert.equal(status.latestVersion, '3.14.0');
    assert.equal(status.installedVersion, '3.13.0');
    assert.equal(status.updateAvailable, true);
    assert.equal(status.latestCheckStatus, 'success');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('readDesktopVersion 返回 null 时回退 bundle 解析并可能为 unknown', async () => {
  // 指向不存在的入口,exe 探测在非真实布局下也会失败 → installedVersion 为 null 但不抛错
  const adapter = new ZcodeMaintenanceAdapter({
    resolveEntry: () => null,
    readProcessLive: () => false,
  });
  const status = await adapter.getStatus();
  assert.equal(status.installSource, 'unknown');
  assert.equal(status.availabilityStage, 'not_installed');
});
