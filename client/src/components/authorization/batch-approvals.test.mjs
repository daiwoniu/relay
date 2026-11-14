import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createBatchApprovalSnapshot, executeBatchApprovals, hasBatchApprovalExceptions } from './batch-approvals.ts';

const reminderLayerSource = await readFile(new URL('./AuthorizationReminderLayer.tsx', import.meta.url), 'utf8');

function approval(id, sessionId, actions, createdAt) {
  return { id, sessionId, sessionTitle: `会话 ${sessionId}`, kind: 'command_approval', title: `请求 ${id}`, summary: id, details: {}, availableActions: actions, createdAt };
}
const key = (sessionId, id) => `${sessionId}::${id}`;

test('普通和异步提问即使携带accept也不进入批量授权', () => {
  const items = [approval('a','s1',['accept'],1), approval('b','s1',['accept'],2),
    {...approval('q','s1',['accept'],3),kind:'user_input'}, {...approval('async','s1',['accept'],4),kind:'async_question'}];
  const byId = Object.fromEntries(items.map(item=>[key(item.sessionId,item.id),item]));
  assert.deepEqual(createBatchApprovalSnapshot(byId,Object.keys(byId)).items.map(item=>item.id),['a','b']);
});

test('批量快照只包含支持 accept 的请求且至少需要两项', () => {
  const approvals = {
    [key('s1', 'a')]: approval('a', 's1', ['accept', 'decline'], 1),
    [key('s2', 'b')]: approval('b', 's2', ['decline'], 2),
    [key('s1', 'c')]: approval('c', 's1', ['accept'], 3),
  };
  const orderedIds = [key('s1', 'a'), key('s2', 'b'), key('s1', 'c')];
  assert.deepEqual(createBatchApprovalSnapshot(approvals, orderedIds)?.ids, [key('s1', 'a'), key('s1', 'c')]);
  assert.equal(createBatchApprovalSnapshot({ [key('s1', 'a')]: approvals[key('s1', 'a')] }, [key('s1', 'a')]), null);
});

test('批量快照将可直接继续的 MCP 映射为 submit 并携带默认表单', () => {
  const command = approval('a', 's1', ['accept'], 1);
  const mcp = {
    ...approval('mcp', 's2', ['accept'], 2),
    kind: 'mcp_elicitation',
    title: '工具需要补充信息',
    details: {
      mode: 'form',
      message: '确认发布环境',
      requestedSchema: {
        type: 'object',
        properties: { environment: { type: 'string', default: 'staging' } },
        required: ['environment'],
      },
    },
  };
  const incomplete = {
    ...mcp,
    id: 'incomplete',
    details: {
      ...mcp.details,
      requestedSchema: {
        type: 'object',
        properties: { environment: { type: 'string' } },
        required: ['environment'],
      },
    },
  };
  const snapshot = createBatchApprovalSnapshot({
    [key('s1', 'a')]: command,
    [key('s2', 'mcp')]: mcp,
    [key('s2', 'incomplete')]: incomplete,
  }, [key('s1', 'a'), key('s2', 'mcp'), key('s2', 'incomplete')]);
  assert.deepEqual(snapshot?.items.map((item) => ({ id: item.id, action: item.responseAction, options: item.responseOptions })), [
    { id: 'a', action: 'accept', options: undefined },
    { id: 'mcp', action: 'submit', options: { formData: { environment: 'staging' } } },
  ]);
});

test('批量快照复用单条授权展示模型并优先保存中文用途', () => {
  const item = approval('a', 's1', ['accept', 'decline'], 1);
  item.title = '需要授权执行命令';
  item.summary = '请求运行命令：Get-Content C:\\Windows\\Temp';
  item.details = { reason: '是否允许只读查看 Windows 临时目录？' };
  const second = approval('b', 's1', ['accept'], 2);
  const mixed = createBatchApprovalSnapshot({
    [key('s1', 'a')]: item,
    [key('s1', 'b')]: second,
  }, [key('s1', 'a'), key('s1', 'b')]);
  assert.deepEqual(mixed?.items[0], {
    approvalKey: key('s1', 'a'),
    id: 'a',
    sessionId: 's1',
    sessionTitle: '会话 s1',
    typeLabel: '命令',
    purpose: '只读查看 Windows 临时目录',
    summary: '请求运行命令：Get-Content C:\\Windows\\Temp',
    responseAction: 'accept',
  });
});

test('冻结快照按会话分组并保持到达顺序，后续新增请求不会加入', () => {
  const approvals = {
    [key('s1', 'shared')]: approval('shared', 's1', ['accept'], 1),
    [key('s2', 'shared')]: approval('shared', 's2', ['accept'], 2),
    [key('s1', 'c')]: approval('c', 's1', ['accept'], 3),
  };
  const snapshot = createBatchApprovalSnapshot(approvals, [key('s1', 'shared'), key('s2', 'shared'), key('s1', 'c')]);
  approvals[key('s3', 'd')] = approval('d', 's3', ['accept'], 4);
  assert.deepEqual(snapshot?.ids, [key('s1', 'shared'), key('s2', 'shared'), key('s1', 'c')]);
  assert.deepEqual(snapshot?.groups.map((group) => [group.sessionId, group.items.map((item) => item.id)]), [['s1', ['shared', 'c']], ['s2', ['shared']]]);
});

test('批量执行逐项等待并传递动作参数、统计 success、skipped 和 failed', async () => {
  const approvals = {
    [key('s1', 'a')]: approval('a', 's1', ['accept'], 1),
    [key('s2', 'b')]: approval('b', 's2', ['accept'], 2),
    [key('s1', 'c')]: approval('c', 's1', ['accept'], 3),
  };
  const snapshot = createBatchApprovalSnapshot(approvals, [key('s1', 'a'), key('s2', 'b'), key('s1', 'c')]);
  const order = [];
  const actions = [];
  const progress = [];
  snapshot.items[1].responseAction = 'submit';
  snapshot.items[1].responseOptions = { formData: { confirmed: true } };
  const options = [];
  const summary = await executeBatchApprovals(snapshot, async (item, action, responseOptions) => {
    order.push(item.id);
    actions.push(action);
    options.push(responseOptions);
    if (item.id === 'a') return { outcome: 'accepted' };
    if (item.id === 'b') return { outcome: 'skipped' };
    throw new Error('failed');
  }, (processed, current) => progress.push([processed, current]));
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual(actions, ['accept', 'submit', 'accept']);
  assert.deepEqual(options, [undefined, { formData: { confirmed: true } }, undefined]);
  assert.deepEqual(summary, { success: 1, skipped: 1, failed: 1 });
  assert.equal(progress.length, 3);
});

test('批量允许仅在存在失效或失败结果时保留异常面板', () => {
  assert.equal(hasBatchApprovalExceptions({ success: 3, skipped: 0, failed: 0 }), false);
  assert.equal(hasBatchApprovalExceptions({ success: 2, skipped: 1, failed: 0 }), true);
  assert.equal(hasBatchApprovalExceptions({ success: 2, skipped: 0, failed: 1 }), true);
});

test('批量允许全部成功时清空面板状态，存在异常时保留完成结果', () => {
  assert.match(reminderLayerSource, /if \(!hasBatchApprovalExceptions\(summary\)\) \{\s*state\.setBatch\(null\);\s*return;\s*\}/);
  assert.match(reminderLayerSource, /state\.setBatch\(\{ \.\.\.current, status: 'complete', processed: snapshot\.requestCount, \.\.\.summary \}\);/);
});
