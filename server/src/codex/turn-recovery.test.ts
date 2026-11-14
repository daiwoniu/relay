import assert from 'node:assert/strict';
import test from 'node:test';
import { loadRecoveryTurn, resolveRecoveryTurn, selectRecoveryTurn, TurnRecoveryError } from './turn-recovery.js';

test('分页定位目标回合并加载该回合的完整 items', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const turn = await loadRecoveryTurn(async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/turns/list') {
      return params.cursor
        ? { data: [{ id: 'target', status: 'inProgress', items: [] }], nextCursor: null }
        : { data: [{ id: 'newer', status: 'completed', items: [] }], nextCursor: 'turn-page-2' };
    }
    return params.cursor
      ? { data: [{ turnId: 'target', item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '完成' } }], nextCursor: null }
      : { data: [{ turnId: 'target', item: { id: 'command', type: 'commandExecution', status: 'completed' } }], nextCursor: 'item-page-2' };
  }, 'thread-1', 'target');

  assert.equal(turn.id, 'target');
  assert.deepEqual(turn.items.map((item) => item.id), ['command', 'answer']);
  assert.deepEqual(calls.map((call) => [call.method, call.params.cursor ?? null]), [
    ['thread/turns/list', null],
    ['thread/turns/list', 'turn-page-2'],
    ['thread/items/list', null],
    ['thread/items/list', 'item-page-2'],
  ]);
});

test('按持久化 turn id 精确恢复最终回复和过程项', () => {
  const recovered = resolveRecoveryTurn({
    status: { type: 'idle' },
    turns: [{
      id: 'turn-1', status: 'completed', items: [
        { id: 'commentary-1', type: 'agentMessage', phase: 'commentary', text: '处理中' },
        { id: 'command-1', type: 'commandExecution', status: 'completed' },
        { id: 'answer-1', type: 'agentMessage', phase: 'final_answer', text: '最终结果' },
      ],
    }],
  }, 'turn-1');

  assert.equal(recovered.content, '最终结果');
  assert.equal(recovered.processContent, '处理中');
  assert.deepEqual(recovered.items.map((item) => item.id), ['command-1']);
  assert.equal(recovered.finalAnswerItemId, 'answer-1');
  assert.deepEqual(recovered.processTimeline.map((entry) => entry.itemId), ['commentary-1', 'command-1', 'answer-1']);
});

test('recovery keeps only the last final_answer item as completed content', () => {
  const recovered = resolveRecoveryTurn({
    status: { type: 'idle' },
    turns: [{
      id: 'turn-1', status: 'completed', items: [
        { id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: 'mid-answer' },
        { id: 'command-1', type: 'commandExecution', status: 'completed' },
        { id: 'final-2', type: 'agentMessage', phase: 'final_answer', text: 'final-answer' },
      ],
    }],
  }, 'turn-1');

  assert.equal(recovered.content, 'final-answer');
  assert.equal(recovered.processContent, 'mid-answer');
  assert.equal(recovered.finalAnswerItemId, 'final-2');
  assert.deepEqual(recovered.processTimeline.map((entry) => entry.itemId), ['final-1', 'command-1', 'final-2']);
});

test('没有 turn id 时只兼容唯一活动回合', () => {
  const turn = selectRecoveryTurn({
    turns: [
      { id: 'old', status: 'completed', items: [] },
      { id: 'active', status: 'inProgress', items: [] },
    ],
  });
  assert.equal(turn.id, 'active');
});

test('可用持久化开始时间定位断线期间已完成的回合', () => {
  const turn = selectRecoveryTurn({
    turns: [{ id: 'completed', status: 'completed', startedAt: 100, items: [] }],
  }, null, 100_500);
  assert.equal(turn.id, 'completed');
});

test('持久化开始时间优先于共享 thread 中其他客户端的唯一活动回合', () => {
  const turn = selectRecoveryTurn({
    turns: [
      { id: 'relay-completed', status: 'completed', startedAt: 100, items: [] },
      { id: 'external-active', status: 'inProgress', startedAt: 400, items: [] },
    ],
  }, null, 100_500);
  assert.equal(turn.id, 'relay-completed');
});

test('开始时间候选超过一个时选择最接近持久化时间的回合', () => {
  const turn = selectRecoveryTurn({
    turns: [
      { id: 'near', status: 'completed', startedAt: 102, items: [] },
      { id: 'later', status: 'completed', startedAt: 110, items: [] },
    ],
  }, null, 100_500);
  assert.equal(turn.id, 'near');
});

test('开始时间相差过大时不误绑定其他客户端的活动回合', () => {
  assert.throws(
    () => selectRecoveryTurn({
      turns: [{ id: 'external-active', status: 'inProgress', startedAt: 400, items: [] }],
    }, null, 100_500),
    (error: unknown) => error instanceof TurnRecoveryError && error.code === 'RESTART_RECOVERY_TURN_NOT_FOUND',
  );
});

test('无法唯一定位时返回稳定恢复错误', () => {
  assert.throws(
    () => selectRecoveryTurn({ turns: [
      { id: 'a', status: 'inProgress', items: [] },
      { id: 'b', status: 'inProgress', items: [] },
    ] }),
    (error: unknown) => error instanceof TurnRecoveryError && error.code === 'RESTART_RECOVERY_TURN_NOT_FOUND',
  );
});

test('活动标记映射为等待交互', () => {
  const recovered = resolveRecoveryTurn({
    status: { type: 'active', activeFlags: ['waitingOnApproval'] },
    turns: [{ id: 'active', status: 'inProgress', items: [] }],
  }, 'active');
  assert.equal(recovered.waitingOnInteraction, true);
});
