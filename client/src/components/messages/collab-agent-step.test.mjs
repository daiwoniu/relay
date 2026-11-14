import assert from 'node:assert/strict';
import test from 'node:test';
import { getCollabAgentStepInfo } from './collab-agent-step.ts';

test('协作代理提示作为标题且完整结果保留换行', () => {
  assert.deepEqual(getCollabAgentStepInfo({
    tool: 'spawnAgent',
    prompt: '并行检查通知行为',
    agentResults: [{
      threadId: 'thread-child',
      status: 'completed',
      message: '检查完成\n未发现其他问题',
    }],
  }), {
    action: '子任务',
    title: '并行检查通知行为',
    fullTitle: '并行检查通知行为',
    metadata: ['1 个子任务 · 1 已完成'],
    output: '检查完成\n未发现其他问题',
  });
});

test('多子任务状态汇总且分别展示完成消息', () => {
  assert.deepEqual(getCollabAgentStepInfo({
    tool: 'wait',
    agentResults: [
      { threadId: 'thread-a', status: 'completed', message: '结果 A' },
      { threadId: 'thread-b', status: 'running', message: null },
      { threadId: 'thread-c', status: 'errored', message: '结果 C' },
    ],
  }), {
    action: '子任务',
    title: '等待子任务',
    fullTitle: '等待子任务',
    metadata: ['3 个子任务 · 1 运行中 · 1 已完成 · 1 失败'],
    output: '子任务 1\n结果 A\n\n子任务 3\n结果 C',
  });
});

test('没有代理结果时仍显示协作操作', () => {
  assert.deepEqual(getCollabAgentStepInfo({ tool: 'sendInput' }), {
    action: '协作操作',
    title: '发送子任务消息',
    fullTitle: '发送子任务消息',
  });
});

test('存在任务名时标题优先显示任务名并保留完整任务描述', () => {
  assert.deepEqual(getCollabAgentStepInfo({
    agentName: '检查消息路由',
    prompt: '检查子线程消息是否会进入主任务的正式回复气泡',
  }), {
    action: '子任务',
    title: '检查消息路由',
    fullTitle: '检查子线程消息是否会进入主任务的正式回复气泡',
  });
});
