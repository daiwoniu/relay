import assert from 'node:assert/strict';
import test from 'node:test';
import { getChatHeaderTitlePresentation } from './chat-header-state.ts';

const session = { id: 'session-a', title: '标题' };

test('候选会话未校准时只让标题进入 loading', () => {
  assert.equal(getChatHeaderTitlePresentation('session-a', undefined, { status: 'loading', generation: 1, error: null }), 'loading');
  assert.equal(getChatHeaderTitlePresentation('session-a', undefined, { status: 'error', generation: 1, error: '失败' }), 'error');
});

test('已有会话数据优先显示标题，空会话保持空状态', () => {
  assert.equal(getChatHeaderTitlePresentation('session-a', session, { status: 'loading', generation: 1, error: null }), 'ready');
  assert.equal(getChatHeaderTitlePresentation(null, undefined, undefined), 'empty');
});
