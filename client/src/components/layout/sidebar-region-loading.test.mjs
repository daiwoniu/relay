import assert from 'node:assert/strict';
import test from 'node:test';
import { getSidebarRegionPresentation } from './sidebar-region-loading.ts';

test('首次加载显示骨架，缓存刷新保留原列表', () => {
  const loading = { status: 'loading', generation: 1, error: null };
  assert.equal(getSidebarRegionPresentation(loading, false), 'loading_empty');
  assert.equal(getSidebarRegionPresentation(loading, true), 'loading_cached');
});

test('导航失败只在侧栏列表区显示错误并保留缓存', () => {
  const failed = { status: 'error', generation: 1, error: '导航失败' };
  assert.equal(getSidebarRegionPresentation(failed, false), 'error_empty');
  assert.equal(getSidebarRegionPresentation(failed, true), 'error_cached');
});
