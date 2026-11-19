import assert from 'node:assert/strict';
import test from 'node:test';

const sessionId = '11111111-1111-4111-8111-111111111111';
const saved = { version: 1, kind: 'session', sessionId };
const values = new Map([['relay_chat_location', JSON.stringify(saved)]]);
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
});
const { useChatStore } = await import('./chat.ts');
const { readStoredChatLocation, resolveInitialChatLocation } = await import('./chat-location.ts');
const { getChatInitializationState } = await import('../components/chat/chat-initialization-state.ts');

test('冷启动只登记恢复目标，不激活缓存会话或展示缓存消息', () => {
  const state = useChatStore.getState();
  assert.equal(state.activeSessionId, null);
  assert.equal(state.pendingRestoreSessionId, sessionId);
  assert.equal(state.activeSessionOpenVersion, 0);
  assert.equal(getChatInitializationState({
    navigationStatus: state.navigationLoadState.status,
    activeSessionId: state.activeSessionId,
    messageStatus: 'ready', hasMessages: true,
  }), 'restoring_location');
});

test('认证恢复与导航重试期间不激活旧会话，成功校验后才打开', () => {
  useChatStore.getState().restoreStoredChatCandidate();
  const first = useChatStore.getState().beginNavigationLoad();
  useChatStore.getState().failNavigationLoad(first, '离线');
  assert.equal(useChatStore.getState().activeSessionId, null);
  assert.equal(useChatStore.getState().pendingRestoreSessionId, sessionId);
  assert.deepEqual(readStoredChatLocation(), saved);
  const generation = useChatStore.getState().beginNavigationLoad();
  const resolved = resolveInitialChatLocation(null, readStoredChatLocation(), [
    { id: sessionId, project_id: 'project-a' },
  ], [{ id: 'project-a', is_system: 1 }]);
  assert.equal(useChatStore.getState().activeSessionId, null);
  useChatStore.getState().setActiveSession(resolved.activeSessionId);
  useChatStore.getState().completeNavigationLoad(generation);
  assert.equal(useChatStore.getState().activeSessionId, sessionId);
  assert.equal(useChatStore.getState().pendingRestoreSessionId, null);
});

test('已删除恢复目标直接转空会话并清理失效位置，不曾激活目标', () => {
  useChatStore.getState().resetAuthenticatedChatState();
  useChatStore.getState().restoreStoredChatCandidate();
  const observedIds = [];
  const unsubscribe = useChatStore.subscribe(state => observedIds.push(state.activeSessionId));
  const generation = useChatStore.getState().beginNavigationLoad();
  const resolved = resolveInitialChatLocation(null, readStoredChatLocation(), [], [{ id: 'default', is_system: 1 }]);
  useChatStore.getState().setCurrentProject(resolved.currentProjectId);
  assert.deepEqual(readStoredChatLocation(), saved);
  useChatStore.getState().setActiveSession('', { autoOpenProjectPicker: resolved.autoOpenProjectPicker });
  useChatStore.getState().completeNavigationLoad(generation);
  unsubscribe();
  assert.ok(observedIds.every(id => !id));
  assert.equal(useChatStore.getState().pendingRestoreSessionId, null);
  assert.equal(readStoredChatLocation().kind, 'empty');
});

test('加载期间主动新建空会话也递增打开版本并取消启动目标', () => {
  values.set('relay_chat_location', JSON.stringify(saved));
  useChatStore.getState().restoreStoredChatCandidate();
  const before = useChatStore.getState().activeSessionOpenVersion;
  useChatStore.getState().setActiveSession('');
  assert.equal(useChatStore.getState().activeSessionOpenVersion, before + 1);
  assert.equal(useChatStore.getState().pendingRestoreSessionId, null);
  assert.equal(readStoredChatLocation().kind, 'empty');
});
