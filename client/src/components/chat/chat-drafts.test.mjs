import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearChatDraft,
  getChatDraftKey,
  readChatDraft,
  writeChatDraft,
} from './chat-drafts.ts';

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test('草稿按会话和待创建项目分别保存到 sessionStorage', () => {
  const storage = createStorage();
  const sessionKey = getChatDraftKey({ sessionId: 'session-1', pendingProjectPath: null, currentProjectId: 'project-1' });
  const pendingKey = getChatDraftKey({ sessionId: null, pendingProjectPath: 'G:\\work\\demo', currentProjectId: null });
  assert.notEqual(sessionKey, pendingKey);
  writeChatDraft(storage, sessionKey, '会话草稿');
  writeChatDraft(storage, pendingKey, '新项目草稿');
  assert.equal(readChatDraft(storage, sessionKey), '会话草稿');
  assert.equal(readChatDraft(storage, pendingKey), '新项目草稿');
});

test('发送成功后清理对应草稿', () => {
  const storage = createStorage();
  const key = getChatDraftKey({ sessionId: 'session-1', pendingProjectPath: null, currentProjectId: null });
  writeChatDraft(storage, key, '待发送');
  clearChatDraft(storage, key);
  assert.equal(readChatDraft(storage, key), '');
});
