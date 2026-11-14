import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { getSessionDeletePendingLabel } from './session-delete-progress.ts';
import { useSessionDeletionProgressStore } from '../../stores/session-deletion-progress.ts';

test('会话删除阶段映射为真实按钮文案并保留默认等待文案', () => {
  assert.equal(getSessionDeletePendingLabel(null), '处理中…');
  assert.equal(getSessionDeletePendingLabel('stopping'), '正在停止任务…');
  assert.equal(getSessionDeletePendingLabel('archiving'), '正在归档 Codex 会话…');
  assert.equal(getSessionDeletePendingLabel('saving'), '正在保存删除结果…');
});

test('会话删除进度按 session 隔离并支持失败、完成和断线清理', () => {
  const store = useSessionDeletionProgressStore.getState();
  store.clearAll();
  store.setStage('session-1', 'archiving');
  store.setStage('session-2', 'saving');
  assert.deepEqual(useSessionDeletionProgressStore.getState().bySessionId, {
    'session-1': 'archiving',
    'session-2': 'saving',
  });
  store.setStage('session-1', null);
  assert.deepEqual(useSessionDeletionProgressStore.getState().bySessionId, { 'session-2': 'saving' });
  store.clearAll();
  assert.deepEqual(useSessionDeletionProgressStore.getState().bySessionId, {});
});

test('WebSocket 与两个删除入口共享会话删除进度状态', () => {
  const websocket = fs.readFileSync(new URL('../../hooks/useRelayWebSocket.ts', import.meta.url), 'utf8');
  const sidebar = fs.readFileSync(new URL('../layout/Sidebar.tsx', import.meta.url), 'utf8');
  const chatView = [
    'ChatView.tsx',
    'ChatViewPresentation.tsx',
    'use-session-delete-progress.ts',
  ].map((file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
  const dialog = fs.readFileSync(new URL('../ui/ConfirmDialog.tsx', import.meta.url), 'utf8');

  assert.match(websocket, /msg\.type === 'session_deletion_progress'[\s\S]*setStage\(msg\.sessionId, msg\.stage\)/);
  assert.match(sidebar, /pendingLabel=\{getSessionDeletePendingLabel\(deleteProgressStage\)\}/);
  assert.match(chatView, /pendingLabel=\{deletePendingLabel\}/);
  assert.match(dialog, /pendingLabel[\s\S]*pending \? pendingLabel : confirmLabel/);
  assert.match(sidebar, /catch \(error\)[\s\S]*clearDeleteProgressStage\(deleteConfirm\.session\.id\)/);
  assert.match(chatView, /finally[\s\S]*clearStage\(sessionId\)/);
  assert.match(chatView, /useSessionDeleteProgress\(\{[\s\S]*deleteTarget/);
});
