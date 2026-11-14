import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isDesktopSidebarViewport,
  resolveSidebarOpenAfterViewportChange,
} from './sidebar-responsive.ts';

test('1024px 以下为移动端，桌面端从 1024px 开始', () => {
  assert.equal(isDesktopSidebarViewport(390), false);
  assert.equal(isDesktopSidebarViewport(1023), false);
  assert.equal(isDesktopSidebarViewport(1024), true);
});

test('只有跨越断点时才自动切换侧栏', () => {
  assert.equal(resolveSidebarOpenAfterViewportChange(false, false, true), true);
  assert.equal(resolveSidebarOpenAfterViewportChange(true, true, false), false);
  assert.equal(resolveSidebarOpenAfterViewportChange(true, false, true), false);
  assert.equal(resolveSidebarOpenAfterViewportChange(false, true, false), true);
});
