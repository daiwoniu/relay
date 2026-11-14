import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./session-menu-items.tsx', import.meta.url), 'utf8');

test('取消归档入口由引擎 capability 决定', () => {
  assert.match(source, /capabilities\?\.archive\s*&&\s*session\.codex_archived\s*&&\s*onUnarchive/);
  assert.doesNotMatch(source, /\.\.\.\(session\.codex_archived\s*&&\s*onUnarchive/);
});

test('Codex 已绑定会话提供末尾分支入口并在运行中禁用', () => {
  assert.match(source, /session\.can_fork\s*&&\s*onFork/);
  assert.match(source, /从当前会话新建/);
  assert.match(source, /isSessionActionInProgress\(session\.status\)/);
  assert.match(source, /forkPending/);
  assert.match(source, /actionBlockedByRunning \? '会话运行中，完成后才能创建新会话' : undefined/);
});

test('进行中的会话禁用删除入口并说明原因', () => {
  assert.match(source, /id: 'delete'[\s\S]*?disabled: actionBlockedByRunning/);
  assert.match(source, /actionBlockedByRunning \? '会话正在处理中，完成后才能删除' : undefined/);

});

test('调用方不提供置顶动作时隐藏置顶入口，并可覆盖跨账号重命名文案', () => {
  assert.match(source, /\.\.\.\(onPin \? \[\{/);
  assert.match(source, /renameLabel = '重命名'/);
  assert.match(source, /id: 'rename',[\s\S]*?label: renameLabel/);
});

test('会话删除确认重新检查最新状态并处理服务端竞态拒绝', () => {
  const deleteProgress = readFileSync(new URL('./use-session-delete-progress.ts', import.meta.url), 'utf8');
  assert.match(deleteProgress, /const confirmDelete[\s\S]*?useChatStore\.getState\(\)\.sessions\.find[\s\S]*?isSessionActionInProgress\(latest\.status\)/);
  assert.match(deleteProgress, /error instanceof ApiError && error\.status === 409/);
});
