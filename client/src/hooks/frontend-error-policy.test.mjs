import test from 'node:test';
import assert from 'node:assert/strict';
import { getFrontendErrorDisposition, shouldKeepLocalSendFeedback } from './frontend-error-policy.ts';

test('sync, read receipts, stop and followup operation errors never terminate an assistant response', () => {
  for (const commandType of ['subscribe', 'unsubscribe', 'mark_session_read', 'cancel', 'cancel_followup', 'resume_followups', 'respond_interaction']) {
    assert.equal(getFrontendErrorDisposition({ commandType, code: 'STORAGE_UNAVAILABLE', messageId: 'old-result' }), 'operation');
  }
  assert.equal(getFrontendErrorDisposition({ code: 'TURN_CANCEL_CONFLICT' }), 'operation');
  assert.equal(getFrontendErrorDisposition({ code: 'FOLLOWUP_CANCEL_FAILED', messageId: 'input' }), 'operation');
  assert.equal(getFrontendErrorDisposition({ code: 'STORAGE_UNAVAILABLE' }), 'operation');
  assert.equal(getFrontendErrorDisposition({ code: 'CODEX_TURN_FAILED' }), 'runtime');
  assert.equal(getFrontendErrorDisposition({ code: 'CODEX_TURN_FAILED', messageId: 'accepted-input' }, false), 'runtime');
  assert.equal(getFrontendErrorDisposition({ code: 'EMPTY_MESSAGE', messageId: 'accepted-input' }, false), 'operation');
});

test('send errors distinguish a rejected intent from an unknown commit result', () => {
  assert.equal(getFrontendErrorDisposition({ commandType: 'send', messageId: 'input', code: 'STORAGE_UNAVAILABLE' }), 'send-uncertain');
  assert.equal(getFrontendErrorDisposition({ commandType: 'send', messageId: 'input', code: 'OPERATION_EXPIRED' }), 'send-uncertain');
  assert.equal(getFrontendErrorDisposition({ commandType: 'send', messageId: 'input', code: 'FORBIDDEN' }), 'send-rejected');
  assert.equal(getFrontendErrorDisposition({ messageId: 'input', code: 'INVALID_ARGUMENT' }), 'send-rejected');
});

test('idle snapshots cannot hide local sending feedback, but guard is scoped and releases after acknowledgement', () => {
  const sending = { localSendPending: true, sessionId: 'a', streamingSessionId: 'a', isWaiting: true };
  assert.equal(shouldKeepLocalSendFeedback(sending), true);
  assert.equal(shouldKeepLocalSendFeedback({ ...sending, sessionId: 'b' }), false);
  assert.equal(shouldKeepLocalSendFeedback({ ...sending, localSendPending: false }), false);
  assert.equal(shouldKeepLocalSendFeedback({ ...sending, isWaiting: false }), false);
});
