import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionEndAttentionEvent, getSessionEndAttentionDecision, isLiveSessionEndTransition } from './session-end-policy.ts';

const session = (status) => ({ id: 'session-1', title: '整理通知设置', created_at: 1, updated_at: 2, pinned: 0, pinned_at: null, project_id: null, codex_archived: false, status });

test('仅运行态实时进入四种终态时形成会话结束提醒', () => {
  for (const previous of ['queued', 'pending', 'processing', 'recovering', 'awaiting_action', 'stopping']) {
    for (const next of ['completed', 'failed', 'stopped', 'interrupted']) {
      assert.equal(isLiveSessionEndTransition(previous, next), true);
    }
  }
  assert.equal(isLiveSessionEndTransition(undefined, 'completed'), false);
  assert.equal(isLiveSessionEndTransition('idle', 'completed'), false);
  assert.equal(isLiveSessionEndTransition('completed', 'completed'), false);
  assert.equal(isLiveSessionEndTransition('failed', 'interrupted'), false);
  assert.equal(isLiveSessionEndTransition('processing', 'idle'), false);
  assert.equal(isLiveSessionEndTransition('queued', 'stopped'), true);
});

test('提醒事件冻结会话标识、标题和终态', () => {
  assert.deepEqual(createSessionEndAttentionEvent('processing', session('failed'), 'user-1'), {
    userId: 'user-1', sessionId: 'session-1', sessionTitle: '整理通知设置', status: 'failed', occurredAt: 2,
  });
  assert.equal(createSessionEndAttentionEvent(undefined, session('completed'), 'user-1'), null);
});

test('订阅快照和恢复同一结果不触发旧任务通知，新结果仍通知', () => {
  const completed = { ...session('completed'), last_result: { messageId: 'result-2', status: 'completed', createdAt: 3 } };
  assert.equal(createSessionEndAttentionEvent('processing', completed, 'user-1', { snapshot: true }), null);
  assert.equal(createSessionEndAttentionEvent('awaiting_action', completed, 'user-1', { previousResultMessageId: 'result-2' }), null);
  assert.equal(createSessionEndAttentionEvent('processing', completed, 'user-1', { previousResultMessageId: 'result-1' }).resultMessageId, 'result-2');
});

test('前台正在查看目标会话时抑制系统通知和声音', () => {
  const base = { pageVisible: true, windowFocused: true, activeSessionId: 'session-1', eventSessionId: 'session-1', systemEnabled: true, systemSupported: true, systemPermission: 'granted', soundEnabled: true };
  assert.deepEqual(getSessionEndAttentionDecision(base), { sendSystemNotification: false, playSound: false });
  assert.deepEqual(getSessionEndAttentionDecision({ ...base, activeSessionId: 'session-2' }), { sendSystemNotification: true, playSound: true });
  assert.equal(getSessionEndAttentionDecision({ ...base, pageVisible: false }).sendSystemNotification, true);
  assert.equal(getSessionEndAttentionDecision({ ...base, windowFocused: false }).playSound, true);
});
