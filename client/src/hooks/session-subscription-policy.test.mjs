import assert from 'node:assert/strict';
import test from 'node:test';
import { selectLiveSessionSubscriptions } from './session-subscription-policy.ts';

const session = (id, status, updated_at = 0) => ({ id, status, updated_at });

test('当前会话始终保留，后台只选择运行态会话', () => {
  assert.deepEqual(selectLiveSessionSubscriptions({
    activeSessionId: 'active',
    sessions: [session('idle', 'idle'), session('active', 'idle'), session('running', 'processing')],
    lastFocusedAt: new Map([['running', 1]]),
    maxBackground: 8,
  }), ['active', 'running']);
});

test('后台超限时等待交互优先，再按最近打开顺序保留运行会话', () => {
  assert.deepEqual(selectLiveSessionSubscriptions({
    activeSessionId: 'active',
    sessions: [
      session('active', 'processing'),
      session('old', 'processing'),
      session('new', 'processing'),
      session('approval', 'awaiting_action'),
      session('queued', 'queued'),
    ],
    lastFocusedAt: new Map([['old', 1], ['approval', 2], ['new', 3]]),
    maxBackground: 2,
  }), ['active', 'approval', 'new']);
});

test('没有当前会话时仍有界保留后台运行会话', () => {
  assert.deepEqual(selectLiveSessionSubscriptions({
    activeSessionId: null,
    sessions: [session('first', 'processing'), session('second', 'recovering')],
    lastFocusedAt: new Map([['first', 1], ['second', 2]]),
    maxBackground: 1,
  }), ['second']);
});

test('从未打开的后台会话使用更新时间淘汰较早会话', () => {
  assert.deepEqual(selectLiveSessionSubscriptions({
    activeSessionId: 'active',
    sessions: [session('active', 'idle'), session('old', 'processing', 1), session('new', 'processing', 2)],
    lastFocusedAt: new Map(),
    maxBackground: 1,
  }), ['active', 'new']);
});
