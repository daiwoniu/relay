import assert from 'node:assert/strict';
import test from 'node:test';
import { getSubAgentActivityLabel, getSubAgentActivityStepInfo, hasSubAgentReportReference } from './sub-agent-activity.ts';

test('从代理路径中提取任务名作为子任务标题', () => {
  assert.deepEqual(getSubAgentActivityStepInfo({
    kind: 'started',
    agentThreadId: 'thread-child',
    agentPath: '/root/long_description_preview',
  }), {
    action: '子任务',
    title: 'long_description_preview',
    fullTitle: 'long_description_preview',
    expandable: false,
  });
});

test('只为带明确子线程和完成回合引用的结束通知提供读取入口', () => {
  const step = { id: 'subagent-completed-turn', type: 'subAgentActivity', status: 'completed', details: { kind: 'completed', agentThreadId: 'child' } };
  assert.equal(hasSubAgentReportReference(step), true);
  for (const change of [{ id: 'unknown-event' }, { type: 'collabAgentToolCall' }, { status: 'incomplete' }, { details: { kind: 'started', agentThreadId: 'child' } }, { details: { kind: 'completed' } }]) {
    assert.equal(hasSubAgentReportReference({ ...step, ...change }), false);
  }
});

test('同一任务的不同活动可区分，并保留引擎实际返回的正文', () => {
  const base = { agentPath: '/root/food_sample' };
  const interacted = getSubAgentActivityStepInfo({ ...base, kind: 'interacted' });
  const completed = getSubAgentActivityStepInfo({ ...base, kind: 'completed', content: '两张图片已完成', model: 'model-a' });
  assert.equal(interacted.title, 'food_sample');
  assert.equal(interacted.expandable, false);
  assert.equal(interacted.output, undefined);
  assert.equal(getSubAgentActivityLabel({ kind: 'interacted' }), '发生交互');
  assert.equal(getSubAgentActivityLabel({ kind: 'completed' }), '执行结束');
  assert.equal(getSubAgentActivityLabel({ kind: 'future-kind' }), '活动通知');
  assert.equal(completed.title, 'food_sample');
  assert.equal(completed.expandable, true);
  assert.equal(completed.output, '两张图片已完成');
  assert.deepEqual(completed.metadata, ['model-a']);
});

test('缺少代理路径时回退到已有名称', () => {
  assert.deepEqual(getSubAgentActivityStepInfo({ agentName: '消息路由检查' }), {
    action: '子任务',
    title: '消息路由检查',
    fullTitle: '消息路由检查',
    expandable: false,
  });
});
