import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApprovalNotificationContent, buildSessionEndNotificationContent } from './browser-notifications.ts';

test('单条系统通知使用授权类型和中文目的而不是完整命令摘要', () => {
  const content = buildApprovalNotificationContent([{
    id: 'approval-1',
    sessionId: '11111111-1111-4111-8111-111111111111',
    sessionTitle: '部署检查',
    engine: 'codebuddy',
    kind: 'command_approval',
    title: '需要授权执行命令',
    summary: '请求运行命令：一段很长的命令',
    details: { reason: '是否允许只读核查部署结果？' },
    availableActions: ['accept'],
    createdAt: 1,
  }]);

  assert.deepEqual(content, {
    title: '部署检查 · CodeBuddy · 命令',
    body: '只读核查部署结果',
  });
});

test('MCP 补充信息生成系统通知', () => {
  const content = buildApprovalNotificationContent([{
    id: 'interaction:2',
    sessionId: '11111111-1111-4111-8111-111111111111',
    sessionTitle: '发布流程',
    engine: 'codex',
    kind: 'mcp_elicitation',
    title: '工具需要补充信息',
    summary: '工具需要补充信息：请选择发布环境',
    details: { message: '请选择发布环境' },
    availableActions: [],
    createdAt: 2,
  }]);
  assert.deepEqual(content, {
    title: '发布流程 · Codex · MCP',
    body: '请选择发布环境',
  });
});

test('OpenCode 授权通知使用品牌名且多引擎通知去重', () => {
  const approval = {
    id: 'interaction:3',
    sessionId: '11111111-1111-4111-8111-111111111111',
    sessionTitle: '模型切换',
    engine: 'opencode',
    kind: 'mcp_elicitation',
    title: '工具需要补充信息',
    summary: '工具需要补充信息：请选择模型',
    details: { message: '请选择要切换的模型' },
    availableActions: [],
    createdAt: 3,
  };
  const single = buildApprovalNotificationContent([approval]);
  assert.match(single.title, /· OpenCode ·/);
  const mixed = buildApprovalNotificationContent([{ ...approval, engine: 'codex' }, approval]);
  assert.match(mixed.title, /Codex \/ OpenCode/);
  assert.match(mixed.title, /2 个授权请求/);
});

test('会话结束通知按终态区分标题并保留会话标题', () => {
  const expected = {
    completed: '任务已完成', failed: '任务执行失败', stopped: '任务已停止', interrupted: '任务意外中断',
  };
  for (const [status, title] of Object.entries(expected)) {
    assert.deepEqual(buildSessionEndNotificationContent({ status, sessionTitle: '通知设置改造' }), {
      title, body: '会话：通知设置改造',
    });
  }
});
