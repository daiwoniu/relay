import assert from 'node:assert/strict';
import test from 'node:test';
import { selectSubAgentReport } from './sub-agent-report.js';

const final = (text: string) => ({ type: 'agentMessage', phase: 'final_answer', text });
const thread = { id: 'child', turns: [
  { id: 'first', status: 'completed', items: [final('第一轮：红烧肉'), { ...final('内部进度'), phase: 'commentary' }] },
  { id: 'second', status: 'completed', items: [final('第二轮：菠菜和大盘鸡')] },
] };
test('按明确完成记录匹配独立回报，不用最后一轮覆盖前一轮', () => {
  assert.equal(selectSubAgentReport(thread, 'child', 'subagent-completed-first'), '第一轮：红烧肉');
  assert.equal(selectSubAgentReport(thread, 'child', 'subagent-completed-second'), '第二轮：菠菜和大盘鸡');
  assert.equal(selectSubAgentReport(thread, 'wrong-child', 'subagent-completed-first'), null);
  assert.equal(selectSubAgentReport(thread, 'child', 'unknown-format'), null);
  assert.equal(selectSubAgentReport(thread, 'child', 'subagent-completed-absent'), null);
});
test('不把运行中、失败、空正文及普通进度作为完成回报，限制返回正文体积', () => {
  for (const status of ['inProgress', 'failed', 'interrupted']) {
    assert.equal(selectSubAgentReport({ id: 'child', turns: [{ ...thread.turns[0], status }] }, 'child', 'subagent-completed-first'), null);
  }
  assert.equal(selectSubAgentReport({ id: 'child', turns: [{ id: 'empty', status: 'completed', items: [final(' ')] }] }, 'child', 'subagent-completed-empty'), null);
  assert.throws(() => selectSubAgentReport({ id: 'child', turns: [{ id: 'large', status: 'completed', items: [final('a'.repeat(200_001))] }] }, 'child', 'subagent-completed-large'), /TOO_LARGE/);
});
