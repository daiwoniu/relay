import assert from 'node:assert/strict';
import test from 'node:test';
import { getChatInitializationState } from './chat-initialization-state.ts';

test('导航恢复只影响消息内容区域，不改变已有消息展示', () => {
  assert.equal(getChatInitializationState({
    navigationStatus: 'loading',
    activeSessionId: null,
    messageStatus: 'idle',
    hasMessages: false,
  }), 'restoring_location');
  assert.equal(getChatInitializationState({
    navigationStatus: 'error',
    activeSessionId: null,
    messageStatus: 'idle',
    hasMessages: false,
  }), 'empty');
});

test('消息请求保留已有缓存，只有无内容失败才显示区域错误', () => {
  assert.equal(getChatInitializationState({
    navigationStatus: 'ready',
    activeSessionId: 'session-a',
    messageStatus: 'loading',
    hasMessages: true,
  }), 'ready');
  assert.equal(getChatInitializationState({
    navigationStatus: 'ready',
    activeSessionId: 'session-a',
    messageStatus: 'error',
    hasMessages: false,
  }), 'message_error');
});

test('会话消息加载完成后可以展示真实空会话', () => {
  assert.equal(getChatInitializationState({
    navigationStatus: 'ready',
    activeSessionId: 'session-a',
    messageStatus: 'ready',
    hasMessages: false,
  }), 'empty');
});
