import assert from 'node:assert/strict';
import test from 'node:test';

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => {},
  },
});

const { useChatStore } = await import('./chat.ts');

function resetStore(activeSessionId = 'session-current') {
  useChatStore.setState({
    activeSessionId,
    messages: {},
    connectionError: null,
    protocolMismatch: null,
    streaming: {
      isWaiting: false,
      waitingStage: 'submitted',
      isStreaming: false,
      isStopping: false,
      currentContent: '',
      processContent: '',
      currentPhase: null,
      startTime: null,
      errorMessage: null,
      processSteps: [],
      processTimeline: [],
      streamingSessionId: null,
      blocks: [],
    },
  });
}

test('协议不兼容保存结构化版本，普通连接错误仍保留字符串', () => {
  resetStore();
  const store = useChatStore.getState();
  store.setConnectionError('连接失败');
  store.setProtocolMismatch({ clientVersion: 11, serverVersion: 10 });
  assert.equal(useChatStore.getState().connectionError, '连接失败');
  assert.deepEqual(useChatStore.getState().protocolMismatch, { clientVersion: 11, serverVersion: 10 });
  store.setProtocolMismatch(null);
  assert.equal(useChatStore.getState().protocolMismatch, null);
});

test('当前会话错误应保留会话归属并持续显示', () => {
  resetStore();

  useChatStore.getState().setError('任务执行失败');

  const { streaming } = useChatStore.getState();
  assert.equal(streaming.errorMessage, '任务执行失败');
  assert.equal(streaming.streamingSessionId, 'session-current');
});

test('commentary 与 final answer 在流式状态中都进入过程回复', () => {
  resetStore();
  const store = useChatStore.getState();
  store.startWaiting();
  store.setStreamingSessionId('session-current');
  store.startStreaming();
  store.appendDelta('正在检查文件', 'commentary');
  store.appendDelta('最终回答', 'final_answer');

  const { streaming } = useChatStore.getState();
  assert.equal(streaming.processContent, '正在检查文件最终回答');
  assert.equal(streaming.currentContent, '');
  assert.deepEqual(streaming.blocks, []);
});

test('final_answer 流式阶段进入过程回复并延迟最终区域', () => {
  resetStore();
  const store = useChatStore.getState();
  store.startWaiting();
  store.setStreamingSessionId('session-current');
  store.startStreaming();
  store.appendDelta('正在检查文件', 'commentary');
  store.appendDelta('最终回答', 'final_answer', 'answer-1');

  const { streaming } = useChatStore.getState();
  assert.equal(streaming.processContent, '正在检查文件最终回答');
  assert.equal(streaming.currentContent, '');
  assert.deepEqual(streaming.blocks, []);
  assert.deepEqual(streaming.processTimeline, [
    { type: 'narrative', itemId: 'answer-1', content: '最终回答' },
  ]);
});

test('phase 未标注时仍实时显示，避免升级后丢内容', () => {
  resetStore();
  const store = useChatStore.getState();
  store.startWaiting();
  store.setStreamingSessionId('session-current');
  store.startStreaming();
  store.appendDelta('最终回答', undefined);

  const { streaming } = useChatStore.getState();
  assert.equal(streaming.currentContent, '最终回答');
});

test('已保存的失败回复在重新发送后仍保留在消息列表', () => {
  resetStore();
  useChatStore.getState().addMessage('session-current', {
    id: 'message-error',
    session_id: 'session-current',
    turn_id: 'turn-error',
    role: 'assistant',
    content: '发送消息失败：连接已断开',
    phase: 'error',
    created_at: 1,
    duration: 100,
    stopped: false,
    isError: true,
  });

  useChatStore.getState().startWaiting();

  const messages = useChatStore.getState().messages['session-current'];
  assert.equal(messages.length, 1);
  assert.equal(messages[0].isError, true);
  assert.equal(messages[0].content, '发送消息失败：连接已断开');
});

test('后台任务错误应绑定事件所属会话且在下次发送时清除', () => {
  resetStore();
  useChatStore.getState().startWaiting();
  useChatStore.getState().setStreamingSessionId('session-running');

  useChatStore.getState().setError('Codex 连接在任务完成前断开', 'session-running');
  assert.equal(useChatStore.getState().streaming.streamingSessionId, 'session-running');
  assert.equal(useChatStore.getState().streaming.errorMessage, 'Codex 连接在任务完成前断开');

  useChatStore.getState().startWaiting();
  assert.equal(useChatStore.getState().streaming.errorMessage, null);
  assert.equal(useChatStore.getState().streaming.streamingSessionId, null);
});
