import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const chatView = fs.readFileSync(new URL('TrashProjectRecoveryDialog.tsx', import.meta.url), 'utf8');
const websocket = fs.readFileSync(new URL('../../hooks/useRelayWebSocket.ts', import.meta.url), 'utf8');
const store = fs.readFileSync(new URL('../../stores/chat.ts', import.meta.url), 'utf8');

test('同路径项目冲突保留待选路径并引导完整恢复', () => {
  assert.match(chatView, /getProjectInTrashConflict\(error\)/);
  assert.match(chatView, /setConflict\(\{ project, path: projectPath, restoreCommitted: false \}\)/);
  assert.match(chatView, /await restoreProjectFromTrash\(conflict\.project\.id\)/);
  assert.match(chatView, /不会创建重复项目/);
  assert.match(chatView, /restoreCommitted/);
  assert.match(chatView, /if \(!restoreCommitted\)/);
  assert.match(chatView, /hasTrashRestoreWarning/);
  assert.doesNotMatch(chatView, /setError\(restoreWarning\)/);
  assert.match(chatView, /自动取消由删除导致的 Codex 归档/);
});

test('跨端恢复复用更新事件，永久删除只移除相关目标', () => {
  assert.match(websocket, /msg\.type === 'project_updated'[\s\S]*upsertProject/);
  assert.match(websocket, /case 'session_updated'/);
  assert.match(websocket, /msg\.type === 'project_deleted'[\s\S]*removeProject/);
  assert.match(websocket, /msg\.type === 'session_deleted'[\s\S]*removeSession/);
  assert.match(store, /const removingActiveSession = state\.activeSessionId === id/);
});
