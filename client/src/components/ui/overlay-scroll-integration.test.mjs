import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const popover = await readFile(new URL('./Popover.tsx', import.meta.url), 'utf8');
const contextMenu = await readFile(new URL('./ContextMenu.tsx', import.meta.url), 'utf8');
const messageList = await readFile(new URL('../chat/MessageList.tsx', import.meta.url), 'utf8');

test('消息列表动态滚动不会关闭已展开菜单', () => {
  assert.match(messageList, /data-overlay-scroll-preserve/);
  assert.match(popover, /shouldClosePopoverForScroll/);
  assert.match(contextMenu, /shouldClosePopoverForScroll/);
});
