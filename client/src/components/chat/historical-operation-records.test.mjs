import assert from 'node:assert/strict';
import test from 'node:test';
import { groupHistoricalOperationRecords, isHistoricalOperationRecord } from './historical-operation-records.ts';

const record = (overrides = {}) => ({ id: 'audit', session_id: 'session', turn_id: 'turn', role: 'assistant',
  phase: 'final_answer', content: '', stopped: false, created_at: 10, duration: 9,
  items: [{ id: 'approval', type: 'interaction', status: 'completed', details: { resolvedAction: 'accept' } }], ...overrides });
const reply = (overrides = {}) => ({ ...record(), id: 'reply', content: 'Recovered answer', outcome: 'completed',
  items: undefined, hasDetails: true, processItemCount: 86, ...overrides });

test('明确且唯一的同会话同回合回复才收纳授权，保留原始对象和懒加载状态', () => {
  const audit = record(); const answer = reply(); const messages = [audit, answer];
  const before = JSON.stringify(messages);
  const result = groupHistoricalOperationRecords(messages);
  assert.deepEqual([...result.nestedIds], ['audit']);
  assert.equal(result.byReply.get('reply')[0], audit);
  assert.equal(answer.items, undefined);
  assert.equal(answer.hasDetails, true);
  assert.equal(JSON.stringify(messages), before);
});

test('不按时间邻近猜测归属，也不跨会话或强行处理多个匹配回复', () => {
  for (const answers of [[reply({ turn_id: 'other-turn' })], [reply({ session_id: 'another-session' })],
    [reply(), reply({ id: 'another-reply' })], [], [reply({ outcome: 'failed' })]]) {
    const result = groupHistoricalOperationRecords([record(), ...answers]);
    assert.equal(result.nestedIds.size, 0); assert.equal(result.byReply.size, 0);
  }
});

test('摘要可折叠且不冒充详情已加载，空白占位及普通工具过程保持原展示', () => {
  assert.equal(isHistoricalOperationRecord(record({ items: undefined, hasDetails: true, processItemCount: 1, processNarrativeCount: 0, historicalOperationRecord: true })), true);
  assert.equal(isHistoricalOperationRecord(record({ phase: 'interaction' })), true);
  for (const overrides of [{ items: [] }, { items: undefined }, { content: 'Real answer' },
    { items: [{ id: 'tool', type: 'commandExecution', status: 'completed' }] },
    { items: undefined, hasDetails: true, processItemCount: 1, processNarrativeCount: 1 }]) {
    assert.equal(isHistoricalOperationRecord(record(overrides)), false);
  }
});

test('待授权、异步提问、失败和停止等需要用户关注的消息不能被收起', () => {
  for (const overrides of [{ items: [{ id: 'approval', type: 'interaction', status: 'in_progress' }] },
    { asyncQuestionIds: ['async-question:q'] }, { stopped: true }, { isError: true },
    { errorCode: 'ERROR' }, { outcome: 'failed' }, { processContent: 'Narrative' },
    { changedFileCount: 1 }, { changedFilesIncomplete: true }, { phase: 'error' }]) {
    assert.equal(isHistoricalOperationRecord(record(overrides)), false);
  }
});

test('普通工具摘要和详情均不误判授权，旧后端缺少类型证据时保持原展示', () => {
  const summary = record({ items: undefined, hasDetails: true, processItemCount: 1, processNarrativeCount: 0 });
  for (const historicalOperationRecord of [undefined, false]) {
    assert.equal(isHistoricalOperationRecord({ ...summary, historicalOperationRecord }), false);
  }
  assert.equal(isHistoricalOperationRecord({ ...summary, historicalOperationRecord: false,
    items: [{ id: 'tool', type: 'commandExecution', status: 'completed' }] }), false);
  const verified = { ...summary, historicalOperationRecord: true };
  assert.equal(isHistoricalOperationRecord(verified), true);
  assert.equal(isHistoricalOperationRecord({ ...verified, items: record().items }), true);
  assert.equal(groupHistoricalOperationRecords([verified, reply()]).nestedIds.size, 1);
});

test('搜索或分享选择保留原消息行，分页窗口中没有回复时保留原记录', () => {
  const audit = record(); const answer = reply();
  const preserved = groupHistoricalOperationRecords([audit, answer], true);
  assert.equal(preserved.nestedIds.size, 0); assert.equal(preserved.byReply.size, 0);
  assert.equal(groupHistoricalOperationRecords([audit]).nestedIds.size, 0);
  assert.equal(groupHistoricalOperationRecords([answer]).byReply.size, 0);
});
