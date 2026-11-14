import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { shouldClosePopoverForWindowResize } from './popover-resize.ts';

const contextMenuSource = await readFile(new URL('./ContextMenu.tsx', import.meta.url), 'utf8');

test('桌面端窗口尺寸变化时关闭浮层', () => {
  assert.equal(shouldClosePopoverForWindowResize(false), true);
});

test('移动端软键盘导致窗口尺寸变化时保持浮层打开', () => {
  assert.equal(shouldClosePopoverForWindowResize(true), false);
});

test('上下文菜单复用移动端键盘 resize 保护且桌面端仍可关闭', () => {
  assert.match(contextMenuSource, /shouldClosePopoverForWindowResize\(mobile\)/);
  assert.match(contextMenuSource, /window\.addEventListener\('resize', handleResize\)/);
  assert.doesNotMatch(contextMenuSource, /window\.addEventListener\('resize', onClose\)/);
});
