import assert from 'node:assert/strict';
import test from 'node:test';

const values = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  },
});

const { readStoredChatLocation } = await import('./chat-location.ts');
const { useChatStore } = await import('./chat.ts');
const sessionId = '11111111-1111-4111-8111-111111111111';

test('空会话项目选择和已有会话切换更新恢复位置', () => {
  values.clear();
  useChatStore.setState({ activeSessionId: null, currentProjectId: null });

  useChatStore.getState().setCurrentProject('project-a');
  assert.deepEqual(readStoredChatLocation(), {
    version: 1,
    kind: 'empty',
    projectId: 'project-a',
    autoOpenProjectPicker: true,
  });

  useChatStore.getState().setActiveSession(sessionId);
  assert.deepEqual(readStoredChatLocation(), {
    version: 1,
    kind: 'session',
    sessionId,
  });

  useChatStore.getState().setCurrentProject('project-b');
  assert.equal(readStoredChatLocation()?.kind, 'session');

  useChatStore.getState().setActiveSession('');
  assert.deepEqual(readStoredChatLocation(), {
    version: 1,
    kind: 'empty',
    projectId: 'project-b',
    autoOpenProjectPicker: true,
  });
  assert.equal(useChatStore.getState().autoOpenProjectPicker, true);

  useChatStore.getState().setActiveSession(sessionId);
  useChatStore.getState().setActiveSession('', { autoOpenProjectPicker: false });
  assert.equal(useChatStore.getState().autoOpenProjectPicker, false);
  assert.deepEqual(readStoredChatLocation(), {
    version: 1,
    kind: 'empty',
    projectId: 'project-b',
    autoOpenProjectPicker: false,
  });
});

test('删除当前会话后保留所属项目且不自动打开项目选择面板', () => {
  values.clear();
  useChatStore.setState({
    activeSessionId: sessionId,
    activeSessionOpenVersion: 5,
    autoOpenProjectPicker: true,
    currentProjectId: 'project-other',
    sessions: [{
      id: sessionId,
      title: '待删除会话',
      created_at: 1,
      updated_at: 1,
      pinned: 0,
      pinned_at: null,
      project_id: 'project-current',
      engine: 'codex',
      codex_archived: false,
      status: 'idle',
    }],
    rightPanelTabs: [],
  });

  useChatStore.getState().removeSession(sessionId);

  const state = useChatStore.getState();
  assert.equal(state.activeSessionId, '');
  assert.equal(state.activeSessionOpenVersion, 6);
  assert.equal(state.currentProjectId, 'project-current');
  assert.equal(state.autoOpenProjectPicker, false);
  assert.deepEqual(state.sessions, []);
  assert.deepEqual(readStoredChatLocation(), {
    version: 1,
    kind: 'empty',
    projectId: 'project-current',
    autoOpenProjectPicker: false,
  });
});

test('空会话项目锁定状态写入位置并可恢复', () => {
  values.clear();
  useChatStore.setState({ activeSessionId: sessionId, currentProjectId: 'project-all', projectSelectionLocked: false });

  useChatStore.getState().setActiveSession('', {
    autoOpenProjectPicker: false,
    projectSelectionLocked: true,
  });

  assert.equal(useChatStore.getState().projectSelectionLocked, true);
  assert.equal(readStoredChatLocation()?.kind, 'empty');
  assert.equal(readStoredChatLocation()?.projectSelectionLocked, true);
});

test('锁定的空会话项目被删除时切换后续项目并解除锁定', () => {
  values.clear();
  useChatStore.setState({
    activeSessionId: '',
    currentProjectId: 'project-all',
    projectSelectionLocked: true,
    projects: [
      { id: 'project-all' },
      { id: 'project-mine' },
    ],
    sessions: [],
  });

  useChatStore.getState().removeProject('project-all');

  const state = useChatStore.getState();
  assert.equal(state.currentProjectId, 'project-mine');
  assert.equal(state.projectSelectionLocked, false);
  assert.deepEqual(readStoredChatLocation(), {
    version: 1,
    kind: 'empty',
    projectId: 'project-mine',
    autoOpenProjectPicker: false,
  });
});

test('导航失败后重试会递增代际并清除旧错误', () => {
  const first = useChatStore.getState().beginNavigationLoad();
  useChatStore.getState().failNavigationLoad(first, '请求超时');
  const second = useChatStore.getState().beginNavigationLoad();
  assert.equal(second, first + 1);
  assert.equal(useChatStore.getState().navigationLoadState.status, 'loading');
  assert.equal(useChatStore.getState().navigationLoadState.error, null);
});

test('WebSocket 重连快照保留未返回会话并拒绝覆盖请求后的本地状态变化', () => {
  const recent = { id: 'recent', title: '最近会话', created_at: 2, updated_at: 2, pinned: 0, pinned_at: null, project_id: null, engine: 'codex', codex_archived: false, status: 'processing' };
  const old = { id: 'old', title: '精确加载的旧会话', created_at: 1, updated_at: 1, pinned: 0, pinned_at: null, project_id: null, engine: 'codex', codex_archived: false, status: 'processing' };
  useChatStore.setState({ sessions: [recent, old] });
  const expectedStatuses = { recent: 'processing', old: 'processing' };
  useChatStore.getState().updateSessionStatus('recent', 'pending');
  useChatStore.getState().mergeReconnectSessionSnapshot([
    { ...recent, title: '服务端标题', status: 'completed' },
  ], expectedStatuses);
  const state = useChatStore.getState();
  assert.equal(state.sessions.find((session) => session.id === 'recent')?.title, '服务端标题');
  assert.equal(state.sessions.find((session) => session.id === 'recent')?.status, 'pending');
  assert.equal(state.sessions.find((session) => session.id === 'old')?.status, 'processing');
});

test('分页快照不会覆盖较新的标题和置顶，重连不会恢复期间已移除的会话', () => {
  const old = { id: 'old', title: '旧标题', updated_at: 1, pinned: 0, status: 'idle' };
  const recent = { ...old, title: '刚置顶', updated_at: 2, pinned: 1 };
  const removed = { ...old, id: 'removed' };
  useChatStore.setState({ sessions: [recent] });
  useChatStore.getState().setSessions([old]);
  assert.deepEqual(useChatStore.getState().sessions, [recent]);
  useChatStore.getState().mergeReconnectSessionSnapshot([old, removed], { old: 'idle', removed: 'idle' });
  assert.deepEqual(useChatStore.getState().sessions, [recent]);
});

test('WebSocket revision 控制同步但不覆盖权威消息计数，跳号标记 dirty', () => {
  useChatStore.setState({
    sessions: [{ id: sessionId, title: '测试会话', created_at: 1, updated_at: 1, pinned: 0, pinned_at: null, project_id: null, engine: 'codex', codex_archived: false, status: 'processing', message_count: 2, assistant_message_count: 1 }],
    messages: {},
    messageLoadBySession: {},
  });
  useChatStore.getState().applyMessageSync(sessionId, [], 3, true, { beforeCreatedAt: 1, beforeId: 'message-1' });
  assert.equal(useChatStore.getState().sessions[0]?.message_count, 2);
  useChatStore.getState().applyMessageSaved(sessionId, {
    id: 'message-5', session_id: sessionId, turn_id: 'turn-5', role: 'assistant', content: '第五条',
    phase: 'final_answer', created_at: 5, duration: null, stopped: false,
  }, 5);
  assert.equal(useChatStore.getState().messageLoadBySession[sessionId].dirty, true);
  assert.equal(useChatStore.getState().messageLoadBySession[sessionId].revision, 5);
  assert.equal(useChatStore.getState().sessions[0]?.message_count, 2);
  useChatStore.getState().applyMessageSaved(sessionId, {
    id: 'message-4', session_id: sessionId, turn_id: 'turn-4', role: 'assistant', content: '迟到的第四条',
    phase: 'final_answer', created_at: 4, duration: null, stopped: false, outcome: 'completed',
  }, 4);
  assert.equal(useChatStore.getState().sessions[0]?.message_count, 2);
  assert.equal(useChatStore.getState().sessions[0]?.status, 'processing');
  useChatStore.getState().applyMessageSync(sessionId, [], 5, false, null);
  assert.equal(useChatStore.getState().messageLoadBySession[sessionId].dirty, false);
  assert.equal(useChatStore.getState().sessions[0]?.assistant_message_count, 1);
  useChatStore.getState().updateSession({ id: sessionId, message_count: 4, assistant_message_count: 2 });
  const replay = useChatStore.getState().messages[sessionId].find(message => message.id === 'message-5');
  useChatStore.getState().applyMessageSaved(sessionId, replay, 5);
  assert.equal(useChatStore.getState().sessions[0]?.message_count, 4);
  assert.equal(useChatStore.getState().sessions[0]?.assistant_message_count, 2);
});

test('后台仅收到末条消息时标记稀疏缓存 dirty', () => {
  useChatStore.setState({
    sessions: [{ id: sessionId, title: '已完成会话', created_at: 1, updated_at: 1, pinned: 0, pinned_at: null, project_id: null, engine: 'codex', codex_archived: false, status: 'completed', message_count: 12 }],
    messages: {},
    messageLoadBySession: {},
  });

  useChatStore.getState().applyMessageSaved(sessionId, {
    id: 'message-12', session_id: sessionId, turn_id: 'turn-12', role: 'assistant', content: '最后一条回复',
    phase: 'final_answer', created_at: 12, duration: null, stopped: false, outcome: 'completed',
  }, 12);

  const state = useChatStore.getState();
  assert.deepEqual(state.messages[sessionId].map((message) => message.id), ['message-12']);
  assert.equal(state.messageLoadBySession[sessionId].revision, 12);
  assert.equal(state.messageLoadBySession[sessionId].dirty, true);
});

test('成功助手消息在同一次状态更新中替换所属流式气泡并收敛会话状态', () => {
  useChatStore.setState({
    sessions: [{ id: sessionId, title: '测试会话', created_at: 1, updated_at: 1, pinned: 0, pinned_at: null, project_id: null, engine: 'codex', codex_archived: false, status: 'processing' }],
    messages: {},
    messageLoadBySession: {},
    streaming: {
      isWaiting: false, waitingStage: 'started', isStreaming: true, isStopping: false,
      currentContent: '流式内容', processContent: '', currentPhase: 'final_answer', startTime: 1,
      errorMessage: null, processSteps: [], processTimeline: [], streamingSessionId: sessionId,
      blocks: [{ type: 'text', content: '流式内容' }], tokenUsage: null,
    },
  });
  let updates = 0;
  const unsubscribe = useChatStore.subscribe(() => { updates += 1; });
  useChatStore.getState().applyMessageSaved(sessionId, {
    id: 'assistant-final', session_id: sessionId, turn_id: 'turn-final', role: 'assistant', content: '最终内容',
    phase: 'final_answer', created_at: 6, duration: null, stopped: false, outcome: 'completed',
  }, 1, true);
  unsubscribe();
  assert.equal(updates, 1);
  assert.equal(useChatStore.getState().messages[sessionId].at(-1)?.content, '最终内容');
  assert.equal(useChatStore.getState().streaming.streamingSessionId, null);
  assert.equal(useChatStore.getState().sessions[0]?.status, 'completed');
});

test('中断助手消息在同一次状态更新中解锁停止中的输入区并收敛会话状态', () => {
  useChatStore.setState({
    sessions: [{ id: sessionId, title: '测试会话', created_at: 1, updated_at: 1, pinned: 0, pinned_at: null, project_id: null, engine: 'codex', codex_archived: false, status: 'stopping' }],
    messages: {},
    messageLoadBySession: {},
    streaming: {
      isWaiting: false, waitingStage: 'started', isStreaming: false, isStopping: true,
      currentContent: '部分内容', processContent: '', currentPhase: 'final_answer', startTime: 1,
      errorMessage: null, processSteps: [], processTimeline: [], streamingSessionId: sessionId,
      blocks: [{ type: 'text', content: '部分内容' }], tokenUsage: null,
    },
  });
  useChatStore.getState().applyMessageSaved(sessionId, {
    id: 'assistant-stopped', session_id: sessionId, turn_id: 'turn-stopped', role: 'assistant', content: '部分内容',
    phase: null, created_at: 7, duration: 1_000, stopped: true, outcome: 'stopped',
  }, 1, true);
  const state = useChatStore.getState();
  assert.equal(state.sessions[0]?.status, 'stopped');
  assert.equal(state.streaming.streamingSessionId, null);
  assert.equal(state.streaming.isStopping, false);
});

test('运行快照在单次状态更新中延迟最终内容', () => {
  useChatStore.setState({
    sessions: [{ id: sessionId, title: '测试会话', created_at: 1, updated_at: 1, pinned: 0, pinned_at: null, project_id: null, engine: 'codex', codex_archived: false, status: 'processing' }],
    streaming: {
      isWaiting: false, waitingStage: 'started', isStreaming: true, isStopping: false,
      currentContent: '旧内容', processContent: '', currentPhase: 'final_answer', startTime: 1,
      errorMessage: null, processSteps: [], processTimeline: [], streamingSessionId: sessionId,
      blocks: [{ type: 'text', content: '旧内容' }], tokenUsage: null,
    },
  });
  const observedContents = [];
  const unsubscribe = useChatStore.subscribe((state) => {
    observedContents.push(state.streaming.currentContent);
  });
  useChatStore.getState().applyRuntimeStreamingSnapshot({
    sessionId,
    startTime: 2,
    waitingStage: 'forwarded',
    isStreaming: true,
    isStopping: false,
    currentContent: '权威快照内容',
    processContent: '处理中',
    processSteps: [],
    processTimeline: [],
  });
  unsubscribe();

  assert.deepEqual(observedContents, ['']);
  assert.equal(useChatStore.getState().streaming.isStreaming, true);
  assert.deepEqual(useChatStore.getState().streaming.blocks, []);
  assert.deepEqual(useChatStore.getState().streaming.processTimeline, [
    { type: 'narrative', itemId: 'runtime-process', content: '处理中' },
    { type: 'narrative', itemId: 'runtime-final', content: '权威快照内容' },
  ]);
});
