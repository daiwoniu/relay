import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const dialog = fs.readFileSync(new URL('./ProjectUploadsDialog.tsx', import.meta.url), 'utf8');
const sidebar = fs.readFileSync(new URL('../layout/Sidebar.tsx', import.meta.url), 'utf8');

test('项目菜单提供上传文件管理入口', () => {
  assert.match(sidebar, /管理上传文件/);
  assert.match(sidebar, /icon: <MenuIcon type="files" \/>/);
  assert.match(sidebar, /ProjectUploadsDialog/);
});

test('删除项目前提醒项目、会话和上传内容均会保留', () => {
  assert.match(sidebar, /title: '磁盘内容会保留'/);
  assert.match(sidebar, /项目、会话、磁盘工作目录和已上传文件均会保留/);
  assert.match(sidebar, /删除后仅从当前 Relay 列表隐藏/);
});

test('上传文件弹窗显示容量并支持选择、批量和全部清理', () => {
  assert.match(dialog, /已用空间/);
  assert.match(dialog, /删除选中/);
  assert.match(dialog, /全部清理/);
  assert.match(dialog, /cleanupBlockedReason/);
  assert.match(dialog, /文件已清理/);
  assert.match(dialog, /MAX_SELECTED_UPLOADS = 10/);
  assert.match(dialog, /selected\.size >= MAX_SELECTED_UPLOADS/);
  assert.match(dialog, /<FileTypeIcon filePath=\{file\.name\}/);
});
