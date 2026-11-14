import assert from 'node:assert/strict';
import test from 'node:test';
import { canCancelFollowup, hasBlockingFollowups } from './session-followups.ts';

test('暂停和结果不确定的后续消息仍占据会话发送队列', () => {
  const followup = (state) => ({ id: state, sessionId: 'session-1', content: '继续', state, createdAt: 1, errorCode: null, replyToAsyncQuestionId: null });
  for (const state of ['received', 'steering', 'queued', 'dispatching', 'paused', 'uncertain']) {
    assert.equal(hasBlockingFollowups([followup(state)]), true, state);
  }
  for (const state of ['steered', 'delivered', 'cancelled']) {
    assert.equal(hasBlockingFollowups([followup(state)]), false, state);
  }
  assert.equal(hasBlockingFollowups(undefined), false);
});

test('待发送和残留状态可取消，已进入引擎的状态不可撤回', () => {
  for (const state of ['received', 'queued', 'paused', 'uncertain']) {
    assert.equal(canCancelFollowup(state), true, state);
  }
  for (const state of ['steering', 'steered', 'dispatching', 'delivered', 'cancelled']) {
    assert.equal(canCancelFollowup(state), false, state);
  }
});
