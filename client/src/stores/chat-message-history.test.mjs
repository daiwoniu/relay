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
const { useSessionOperationErrorStore } = await import('./session-operation-errors.ts');

function message(id) {
  return {
    id,
    session_id: 'session-1',
    turn_id: 'turn-1',
    role: 'assistant',
    content: id,
    phase: 'final_answer',
    created_at: Number(id.replace('message-', '')),
    duration: null,
    stopped: false,
  };
}

test('取消结果未知只显示提示，保留运行状态与已生成内容直到真实终态', () => {
  useChatStore.setState({ messages: {}, messageLoadBySession: {},
    sessions: [{ id: 'session-1', status: 'stopping' }],
    streaming: { isStreaming: true, isStopping: true, streamingSessionId: 'session-1', currentContent: '已生成正文',
      processContent: '已有过程', processSteps: [{ id: 'tool-1' }], processTimeline: [{ type: 'operation', itemId: 'tool-1' }] } });
  const before = useChatStore.getState().streaming;
  useChatStore.getState().setNonTerminalError('停止结果暂时无法确认');
  const after = useChatStore.getState().streaming;
  assert.deepEqual(after, before);
  assert.equal(useSessionOperationErrorStore.getState().bySession['session-1'], '停止结果暂时无法确认');
  assert.equal(useChatStore.getState().sessions[0].status, 'stopping');
  useChatStore.getState().applyMessageSaved('session-1', { ...message('message-2'), outcome: 'completed' }, 2, true);
  assert.equal(useChatStore.getState().streaming.isStreaming, false);
  assert.equal(useChatStore.getState().streaming.errorMessage, null);
  assert.equal(useChatStore.getState().sessions[0].status, 'completed');
});

test('operation notices for another session never modify the tracked streaming session', () => {
  useChatStore.getState().startWaiting();
  useChatStore.getState().setStreamingSessionId('session-a');
  useChatStore.getState().startStreaming();
  useChatStore.getState().appendDelta('session-a output');
  const before = useChatStore.getState().streaming;
  useChatStore.getState().setNonTerminalError('session-b sync failed', 'session-b');
  assert.deepEqual(useChatStore.getState().streaming, before);
  assert.equal(useSessionOperationErrorStore.getState().bySession['session-b'], 'session-b sync failed');
  assert.notEqual(useSessionOperationErrorStore.getState().bySession['session-a'], 'session-b sync failed');
  useSessionOperationErrorStore.getState().clear('session-b');
  assert.equal(useSessionOperationErrorStore.getState().bySession['session-b'], undefined);
  useSessionOperationErrorStore.getState().reset();
  assert.deepEqual(useSessionOperationErrorStore.getState().bySession, {});
});

test('审批保存保留活动流、正文和过程，真正终态才清理', () => {
  useChatStore.setState({ messages: {}, messageLoadBySession: {},
    sessions: [{ id: 'session-1', status: 'processing' }],
    streaming: { isStreaming: true, streamingSessionId: 'session-1', currentContent: '正在输出',
      processContent: '已核查', processSteps: [{ id: 'tool-1' }], processTimeline: [{ type: 'operation', itemId: 'tool-1' }] } });
  const approval = { ...message('message-1'), content: '', outcome: 'completed' };
  useChatStore.getState().applyMessageSaved('session-1', approval, 1, true);
  assert.equal(useChatStore.getState().streaming.currentContent, '正在输出');
  assert.equal(useChatStore.getState().streaming.processSteps.length, 1);
  assert.equal(useChatStore.getState().sessions[0].status, 'processing');
  useChatStore.getState().applyMessageSaved('session-1', { ...message('message-2'), outcome: 'completed' }, 2, true);
  assert.equal(useChatStore.getState().streaming.isStreaming, false);
  assert.equal(useChatStore.getState().sessions[0].status, 'completed');
});

test('历史消息前插时按 ID 去重并保留实时新增消息', () => {
  useChatStore.setState({
    messages: {
      'session-1': [message('message-3'), message('message-4')],
    },
  });

  useChatStore.getState().addMessage('session-1', message('message-5'));
  useChatStore.getState().prependMessages('session-1', [
    message('message-1'),
    message('message-2'),
    message('message-3'),
  ]);

  assert.deepEqual(
    useChatStore.getState().messages['session-1'].map((item) => item.id),
    ['message-1', 'message-2', 'message-3', 'message-4', 'message-5'],
  );
});

test('历史页输入顺序不稳定时仍按创建时间从旧到新排列', () => {
  useChatStore.setState({
    messages: {
      'session-1': [message('message-3'), message('message-4')],
    },
  });

  useChatStore.getState().prependMessages('session-1', [
    message('message-2'),
    message('message-1'),
    message('message-3'),
  ]);

  assert.deepEqual(
    useChatStore.getState().messages['session-1'].map((item) => item.id),
    ['message-1', 'message-2', 'message-3', 'message-4'],
  );
});
