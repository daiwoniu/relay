import assert from 'node:assert/strict';
import test from 'node:test';
import { getSubAgentActivityStepInfo } from './sub-agent-activity.ts';

test('从代理路径中提取任务名作为子任务标题', () => {
  assert.deepEqual(getSubAgentActivityStepInfo({
    kind: 'started',
    agentThreadId: 'thread-child',
    agentPath: '/root/long_description_preview',
  }), {
    action: '子任务',
    title: 'long_description_preview',
    fullTitle: 'long_description_preview',
  });
});

test('缺少代理路径时回退到已有名称', () => {
  assert.deepEqual(getSubAgentActivityStepInfo({ agentName: '消息路由检查' }), {
    action: '子任务',
    title: '消息路由检查',
    fullTitle: '消息路由检查',
  });
});
