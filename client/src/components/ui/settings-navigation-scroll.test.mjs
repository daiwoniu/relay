import assert from 'node:assert/strict';
import test from 'node:test';
import { hasSettingsNavigationForwardScroll } from './settings-navigation-scroll.ts';

test('设置导航仅在右侧仍有可滚动内容时显示提示', () => {
  assert.equal(hasSettingsNavigationForwardScroll({ scrollLeft: 0, clientWidth: 320, scrollWidth: 500 }), true);
  assert.equal(hasSettingsNavigationForwardScroll({ scrollLeft: 180, clientWidth: 320, scrollWidth: 500 }), false);
});

test('设置导航将末端亚像素差异视为已滚动到底', () => {
  assert.equal(hasSettingsNavigationForwardScroll({ scrollLeft: 179.25, clientWidth: 320, scrollWidth: 500 }), false);
  assert.equal(hasSettingsNavigationForwardScroll({ scrollLeft: 178.5, clientWidth: 320, scrollWidth: 500 }), true);
});
