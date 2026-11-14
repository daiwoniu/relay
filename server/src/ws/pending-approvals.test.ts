import assert from 'node:assert/strict';
import test from 'node:test';
import { presentPendingApproval } from './pending-approvals.js';

const sessionId = '11111111-1111-4111-8111-111111111111';

function present(details: Record<string, unknown>) {
  return presentPendingApproval({
    sessionId,
    sessionTitle: '测试会话',
    engine: 'codex',
    item: { id: 'interaction:1', type: 'interaction', status: 'in_progress', details },
    createdAt: 123,
  });
}

function presentForEngine(engine: 'codex' | 'codebuddy', details: Record<string, unknown>) {
  return presentPendingApproval({
    sessionId,
    sessionTitle: '测试会话',
    engine,
    item: { id: 'interaction:1', type: 'interaction', status: 'in_progress', details },
    createdAt: 123,
  });
}

test('命令授权优先使用命令摘要并限制长度', () => {
  const approval = present({
    interactionKind: 'command_approval',
    title: '运行命令',
    command: `npm test ${'x'.repeat(220)}`,
    availableDecisions: ['accept', 'decline'],
  });
  assert.equal(approval?.kind, 'command_approval');
  assert.equal(approval?.summary.length, 180);
  assert.match(approval?.summary || '', /^请求运行命令：npm test/);
  assert.deepEqual(approval?.availableActions, ['accept', 'decline']);
});

test('文件授权列出首个文件和剩余数量', () => {
  const approval = present({
    interactionKind: 'file_approval',
    title: '修改文件',
    fileChanges: { 'a.ts': { type: 'update' }, 'b.ts': { type: 'create' }, 'c.ts': { type: 'delete' } },
  });
  assert.equal(approval?.summary, '请求修改文件：a.ts，另有 2 个文件');
  assert.deepEqual(approval?.availableActions, ['accept', 'accept_for_session', 'decline', 'cancel']);
  assert.equal(present({
    interactionKind: 'file_approval',
    title: '修改文件',
    rawInput: { filePath: 'D:\\workspace\\a.ts' },
  })?.summary, '请求修改文件：D:\\workspace\\a.ts');
});

test('权限授权优先中文语义并提供稳定兜底', () => {
  assert.equal(present({ interactionKind: 'permissions_approval', title: '请求权限', reason: '读取配置' })?.summary, '请求额外权限：读取配置');
  assert.equal(present({ interactionKind: 'permissions_approval', title: '请求权限', reason: '访问 API', networkApprovalContext: { host: 'example.com' } })?.summary, '请求访问网络：访问 API');
  assert.equal(present({ interactionKind: 'permissions_approval', title: '请求权限' })?.summary, '请求额外权限');
});

test('MCP 补充信息进入待处理提醒但不伪造直接授权动作', () => {
  const approval = present({
    interactionKind: 'mcp_elicitation',
    title: '工具需要补充信息',
    message: '请选择发布环境',
    serverName: 'release-helper',
  });
  assert.equal(approval?.kind, 'mcp_elicitation');
  assert.equal(approval?.summary, '工具需要补充信息：请选择发布环境');
  assert.deepEqual(approval?.availableActions, []);
});

test('投影待处理授权与 MCP 提醒并严格过滤决定', () => {
  const question = present({ interactionKind: 'user_input', title: '需要回答', questions: [{ id: 'q', question: '选择哪个环境？' }] });
  assert.equal(question?.kind, 'user_input');
  assert.equal(question?.summary, '选择哪个环境？');
  assert.deepEqual(question?.availableActions, []);
  assert.deepEqual(present({
    interactionKind: 'command_approval',
    title: '运行命令',
    command: 'npm test',
    availableDecisions: ['acceptForSession', 'unknown', 1, 'cancel'],
  })?.availableActions, ['accept_for_session', 'cancel']);
});

test('异步提问提供问题摘要且不能继承允许动作', () => {
  const question = present({ interactionKind: 'async_question', questions: [{ title: '下一步怎么做？' }], availableDecisions: ['accept'] });
  assert.equal(question?.kind, 'async_question');
  assert.equal(question?.summary, '下一步怎么做？');
  assert.deepEqual(question?.availableActions, []);
});

test('CodeBuddy 授权保留来源并复用统一决定列表', () => {
  const approval = presentForEngine('codebuddy', {
    interactionKind: 'command_approval',
    title: '需要授权执行命令',
    command: 'Write-Output ok',
    availableDecisions: ['acceptForSession', 'accept', 'decline'],
  });
  assert.equal(approval?.engine, 'codebuddy');
  assert.deepEqual(approval?.availableActions, ['accept_for_session', 'accept', 'decline']);
});

test('明确空决定列表不得扩张为全部授权动作', () => {
  assert.deepEqual(present({
    interactionKind: 'permissions_approval',
    title: '需要授权使用工具',
    availableDecisions: [],
  })?.availableActions, []);
  assert.deepEqual(present({
    interactionKind: 'permissions_approval',
    title: '需要授权使用工具',
  })?.availableActions, ['accept', 'accept_for_session', 'decline', 'cancel']);
});
