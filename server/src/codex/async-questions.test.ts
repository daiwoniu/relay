import assert from 'node:assert/strict';
import test from 'node:test';
import { canSubmitAsyncQuestionAnswer, hasUnansweredAsyncQuestion, toAsyncQuestionItem } from './async-questions.js';
import { presentProcessItem } from '../messages/presenter.js';

test('Codex async agent message becomes a durable question item', () => {
  const result = toAsyncQuestionItem({
    id: 'call-1', type: 'agentMessage', delivery: 'async',
    questions: [{ title: '继续提交吗？', options: ['提交', '暂缓'] }],
  });
  assert.deepEqual(result, {
    id: 'async-question:call-1', type: 'interaction', status: 'in_progress',
    details: {
      interactionKind: 'async_question', sourceItemId: 'call-1',
      title: '继续提交吗？',
      questions: [{ title: '继续提交吗？', options: ['提交', '暂缓'] }],
    },
  });
});

test('only a card answer linked to the same question resolves it', () => {
  const card = { role: 'assistant', items: JSON.stringify([{ id: 'async-question:call-1', type: 'interaction', details: { interactionKind: 'async_question' } }]), metadata: null };
  const ordinary = { role: 'user', items: null, metadata: '{}' };
  const answer = { role: 'user', items: null, metadata: JSON.stringify({ replyToAsyncQuestionId: 'async-question:call-1' }) };
  assert.equal(hasUnansweredAsyncQuestion([card, ordinary], 'async-question:call-1'), true);
  assert.equal(hasUnansweredAsyncQuestion([card, ordinary, answer], 'async-question:call-1'), false);
  assert.equal(hasUnansweredAsyncQuestion([card], 'async-question:other'), false);
});

test('async question survives the process item presenter', () => {
  const item = toAsyncQuestionItem({ id: 'call-1', type: 'agentMessage', delivery: 'async', questions: [{ title: '继续？', options: ['继续', '暂停'] }] });
  assert.ok(item);
  assert.deepEqual(presentProcessItem(item), {
    id: 'async-question:call-1', type: 'interaction', status: 'in_progress',
    details: { interactionKind: 'async_question', sourceItemId: 'call-1', title: '继续？', questions: [{ title: '继续？', options: ['继续', '暂停'] }] },
  });
});

test('ordinary agent messages cannot create async questions', () => {
  assert.equal(toAsyncQuestionItem({ id: 'msg-1', type: 'agentMessage', text: '请选择提交' }), null);
  assert.equal(toAsyncQuestionItem({ id: 'msg-2', type: 'agentMessage', delivery: 'async', questions: [] }), null);
});

test('运行态问题可回答，同一问题已有后续消息时拒绝重复回答', () => {
  const questionId = 'async-question:call-live';
  const live = toAsyncQuestionItem({ id: 'call-live', type: 'agentMessage', delivery: 'async', questions: [{ title: '继续？' }] });
  assert.ok(live);
  const input = { questionId, messageId: 'answer-1', ownerUserId: 'owner', actorUserId: 'owner', history: [], runtimeItems: [live], followups: [] };
  assert.equal(canSubmitAsyncQuestionAnswer(input), true);
  assert.equal(canSubmitAsyncQuestionAnswer({ ...input, actorUserId: 'viewer' }), false);
  assert.equal(canSubmitAsyncQuestionAnswer({ ...input, followups: [{ id: 'answer-2', replyToAsyncQuestionId: questionId, state: 'queued' }] }), false);
  assert.equal(canSubmitAsyncQuestionAnswer({ ...input, followups: [{ id: 'answer-1', replyToAsyncQuestionId: questionId, state: 'queued' }] }), true);
  assert.equal(canSubmitAsyncQuestionAnswer({ ...input, questionId: 'async-question:other' }), false);
});
