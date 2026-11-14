import assert from 'node:assert/strict';
import test from 'node:test';
import { collectPendingApprovals } from './pending-approvals.js';

const sessionA = '11111111-1111-4111-8111-111111111111';
const sessionB = '22222222-2222-4222-8222-222222222222';

test('全局待处理集合包含 MCP 提醒并按创建时间和稳定标识排序', () => {
  const approvals = collectPendingApprovals([
    {
      sessionId: sessionB,
      sessionTitle: '会话 B',
      engine: 'codebuddy',
      items: [{ id: 'interaction:2', type: 'interaction', status: 'in_progress', details: { interactionKind: 'file_approval', title: '修改文件', grantRoot: 'b.ts' } }],
      pending: [{ interactionId: 'interaction:2', createdAt: 20 }],
    },
    {
      sessionId: sessionA,
      sessionTitle: '会话 A',
      engine: 'codex',
      items: [
        { id: 'interaction:3', type: 'interaction', status: 'in_progress', details: { interactionKind: 'user_input', title: '回答问题' } },
        { id: 'interaction:1', type: 'interaction', status: 'in_progress', details: { interactionKind: 'command_approval', title: '运行命令', command: 'npm test' } },
        { id: 'interaction:4', type: 'interaction', status: 'in_progress', details: { interactionKind: 'mcp_elicitation', title: '工具需要补充信息', message: '请选择发布环境' } },
      ],
      pending: [
        { interactionId: 'interaction:3', createdAt: 10 },
        { interactionId: 'interaction:1', createdAt: 20 },
        { interactionId: 'interaction:4', createdAt: 30 },
      ],
    },
  ]);
  assert.deepEqual(approvals.map((approval) => approval.id), ['interaction:1', 'interaction:2', 'interaction:4']);
});
