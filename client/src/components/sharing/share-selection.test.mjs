import assert from 'node:assert/strict';
import test from 'node:test';
import { getFinalCompletedAssistantIndex, getSelectableMessageIds, normalizeSelectedMessageIds, shouldDimShareMessage } from './share-selection.ts';

const messages = [
  { id: 'u1', role: 'user', outcome: undefined },
  { id: 'a1', role: 'assistant', outcome: 'completed' },
  { id: 'u2', role: 'user', outcome: undefined },
  { id: 'a2', role: 'assistant', outcome: 'failed' },
  { id: 'u3', role: 'user', outcome: undefined },
];

test('最后一条已完成助手消息决定可分享截止线', () => {
  assert.equal(getFinalCompletedAssistantIndex(messages), 1);
  assert.deepEqual([...getSelectableMessageIds(messages)], ['u1', 'a1']);
});

test('多选结果按原消息顺序归一化并移除截止线外消息', () => {
  assert.deepEqual(normalizeSelectedMessageIds(messages, ['a1', 'u3', 'u1']), ['u1', 'a1']);
  assert.deepEqual(normalizeSelectedMessageIds(messages, []), []);
});

test('仅在分享选择模式中弱化不可选消息', () => {
  assert.equal(shouldDimShareMessage(false, false), false);
  assert.equal(shouldDimShareMessage(false, true), false);
  assert.equal(shouldDimShareMessage(true, true), false);
  assert.equal(shouldDimShareMessage(true, false), true);
});
