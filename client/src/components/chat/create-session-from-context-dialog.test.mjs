import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dialog = readFileSync(new URL('./CreateSessionFromContextDialog.tsx', import.meta.url), 'utf8');
const chatView = readFileSync(new URL('./ChatView.tsx', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../layout/Sidebar.tsx', import.meta.url), 'utf8');

test('会话菜单和消息回复入口创建前均要求二次确认', () => {
  assert.match(dialog, /从此处创建新会话？/);
  assert.match(dialog, /从会话开始到这条回复（含）为止的全部消息与上下文/);
  assert.match(dialog, /基于当前会话创建新会话？/);
  assert.match(dialog, /原会话及其消息不会改变/);
  assert.match(dialog, /创建成功后将自动进入新会话/);
  assert.match(chatView, /setCreateSessionTarget/);
  assert.match(chatView, /onForkMessage: currentSession\?\.can_fork\s*\n\s*\?/);
  assert.match(chatView, /onConfirmCreateSession=\{confirmCreateSessionFromContext\}/);
  assert.match(sidebar, /onConfirm=\{confirmSessionFork\}/);
});
