import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compactMessageItemsJsonForStorage,
  compactProcessItemsForStorage,
} from './storage.js';
import { parseMessageItems } from './presenter.js';

test('文件变更与协作结果压缩及历史再投影不丢工作目录、种类或结果', () => {
  const original=[{id:'files',type:'fileChange',cwd:'D:/outside/project',changes:[{path:'a.ts',kind:{type:'delete'}}]},
    {id:'collab',type:'collabAgentToolCall',agentsStates:{child:{status:'completed',message:'done'}}}];
  const stored=compactProcessItemsForStorage(original);
  const loaded=parseMessageItems(JSON.stringify(stored))!;
  assert.equal(loaded[0].details.cwd,'D:/outside/project');
  assert.deepEqual(loaded[0].details.changes,[{path:'a.ts',changeType:'delete'}]);
  assert.deepEqual(loaded[1].details.agentResults,[{threadId:'child',status:'completed',message:'done'}]);
  assert.deepEqual(compactProcessItemsForStorage(loaded),stored);
});

test('原始MCP失败在压缩保存和历史读回后仍然失败', () => {
  const stored=compactProcessItemsForStorage([{id:'failed-mcp',type:'mcpToolCall',status:'failed',server:'remote',tool:'read_file'}]);
  const [loaded]=parseMessageItems(JSON.stringify(stored)) || [];
  assert.equal(loaded?.status,'incomplete');
  assert.equal(loaded?.details.server,'remote');
});

test('MCP元数据经过实时投影、压缩及历史读回不丢失服务和只读语义', () => {
  const [stored]=compactProcessItemsForStorage([{id:'mcp-source',type:'mcpToolCall',status:'completed',server:'xinshu',tool:'data_asset.relationships',readOnlyHint:true,result:'brief'}]);
  const [loaded]=parseMessageItems(JSON.stringify([stored])) || [];
  assert.equal(loaded?.details.server,'xinshu');
  assert.equal(loaded?.details.readOnlyHint,true);
  assert.equal(loaded?.details.result,undefined);
});

test('命令输出移除 ANSI 和控制字符后保存结构化首尾摘要', () => {
  const [item] = compactProcessItemsForStorage([{
    id: 'command-1',
    type: 'commandExecution',
    status: 'completed',
    command: 'npm test',
    aggregatedOutput: '\u001b[32m第一行\u001b[0m\n中间\u0000内容\n最后一行',
    exitCode: 0,
    durationMs: 123,
  }]);

  assert.deepEqual(item, {
    id: 'command-1',
    type: 'commandExecution',
    status: 'completed',
    details: {
      command: 'npm test',
      exitCode: 0,
      durationMs: 123,
      outputSummary: {
        source: 'aggregatedOutput',
        lineCount: 3,
        charCount: 13,
        firstLine: '第一行',
        lastLine: '最后一行',
        truncated: true,
      },
    },
  });
});

test('工具结果按固定优先级摘要并移除所有原始输出字段', () => {
  const [item] = compactProcessItemsForStorage([{
    id: 'tool-1',
    type: 'mcpToolCall',
    status: 'incomplete',
    name: 'fetch',
    result: '结果第一行\n结果末行',
    output: '不应选择',
    errorCode: 'TOOL_FAILED',
  }]);

  assert.equal(Object.hasOwn(item.details, 'result'), false);
  assert.equal(Object.hasOwn(item.details, 'output'), false);
  assert.deepEqual(item.details.outputSummary, {
    source: 'result',
    lineCount: 2,
    charCount: 10,
    firstLine: '结果第一行',
    lastLine: '结果末行',
    truncated: false,
  });
  assert.equal(item.details.errorCode, 'TOOL_FAILED');
});

test('命令类字段保留首尾且总长度有界', () => {
  const command = `开始-${'x'.repeat(9_000)}-结束`;
  const [item] = compactProcessItemsForStorage([{
    id: 'command-2', type: 'commandExecution', status: 'completed', command,
  }]);
  const stored = String(item.details.command);
  assert.ok(stored.length <= 8 * 1024);
  assert.match(stored, /^开始-/);
  assert.match(stored, /-结束$/);
  assert.match(stored, /Relay 已省略 \d+ 个字符/);
});

test('reasoning 文本限制为 16 KiB', () => {
  const content = `头-${'思'.repeat(17_000)}-尾`;
  const [item] = compactProcessItemsForStorage([{
    id: 'reasoning-1', type: 'reasoning', status: 'completed', content,
  }]);
  const stored = String(item.details.content);
  assert.ok(stored.length <= 16 * 1024);
  assert.match(stored, /^头-/);
  assert.match(stored, /-尾$/);
});

test('interaction 的问题、选项与安全策略完整保留', () => {
  const interaction = {
    id: 'interaction-1',
    type: 'interaction',
    status: 'completed',
    interactionKind: 'approval',
    title: '是否执行',
    message: '请确认',
    availableDecisions: ['accept', 'decline'],
    questions: [{ id: 'q1', question: '选择方式', options: [{ label: '安全模式' }] }],
    networkApprovalContext: { host: 'example.test', reason: '下载依赖' },
    proposedExecpolicyAmendment: { command: 'npm install', decision: 'prompt' },
  };
  const [item] = compactProcessItemsForStorage([interaction]);
  assert.equal(item.id, 'interaction-1');
  assert.deepEqual(item.details.availableDecisions, interaction.availableDecisions);
  assert.deepEqual(item.details.questions, interaction.questions);
  assert.deepEqual(item.details.networkApprovalContext, interaction.networkApprovalContext);
  assert.deepEqual(item.details.proposedExecpolicyAmendment, interaction.proposedExecpolicyAmendment);
});

test('interaction 决定白名单可持久化回读且移除额外原始请求', () => {
  const original = JSON.stringify([{
    id: 'interaction-decision', type: 'interaction', status: 'completed',
    interactionKind: 'command_approval', title: '运行命令', resolvedAction: 'accept',
    decisionSource: 'project_trust', effectiveScope: 'project', trustExpiresAt: null, decidedAt: 5_000,
    rawRequest: { command: '不得复制' }, accessToken: '不得复制',
  }]);
  const compacted = compactMessageItemsJsonForStorage(original);
  const [stored] = JSON.parse(compacted.value || '[]');
  assert.deepEqual(stored.details, {
    interactionKind: 'command_approval', title: '运行命令', resolvedAction: 'accept',
    decisionSource: 'project_trust', effectiveScope: 'project', trustExpiresAt: null, decidedAt: 5_000,
  });
  assert.deepEqual(parseMessageItems(compacted.value)?.[0]?.details, stored.details);
  assert.equal(compactMessageItemsJsonForStorage(compacted.value).changed, false);
});

test('损坏或不一致的 interaction 决定来源不会进入回读 DTO', () => {
  const [stored] = compactProcessItemsForStorage([{
    id: 'interaction-invalid', type: 'interaction', status: 'completed',
    resolvedAction: 'accept', decisionSource: 'project_trust', effectiveScope: 'session',
    trustExpiresAt: -1, decidedAt: 'future',
  }]);
  assert.equal(stored.details.resolvedAction, 'accept');
  assert.equal(stored.details.decisionSource, undefined);
  assert.equal(stored.details.effectiveScope, undefined);
  assert.equal(stored.details.trustExpiresAt, undefined);
  assert.equal(stored.details.decidedAt, undefined);
});

test('文件变化只保留路径与变更类型', () => {
  const [item] = compactProcessItemsForStorage([{
    id: 'file-1',
    type: 'fileChange',
    status: 'completed',
    diff: '顶层大量 diff',
    summary: '不应保留内容摘要',
    changes: [{ path: 'src/app.ts', changeType: 'modified', diff: '大量 diff', secret: 'x' }],
    files: [{ filePath: 'src/old.ts', type: 'deleted', content: '旧内容' }],
  }]);
  assert.deepEqual(item.details.changes, [{ path: 'src/app.ts', changeType: 'modified' }]);
  assert.deepEqual(item.details.files, [{ filePath: 'src/old.ts', changeType: 'deleted' }]);
  assert.equal(item.details.diff, undefined);
  assert.equal(item.details.summary, undefined);
});

test('嵌套 commandActions 的命令同样受 8 KiB 上限约束', () => {
  const [item] = compactProcessItemsForStorage([{
    id: 'command-actions-1', type: 'commandExecution', status: 'completed',
    commandActions: [{ command: `开始-${'x'.repeat(9_000)}-结束` }],
  }]);
  const stored = String((item.details.commandActions as Array<{ command: string }>)[0]?.command);
  assert.ok(stored.length <= 8 * 1024);
  assert.match(stored, /^开始-/);
  assert.match(stored, /-结束$/);
});

test('JSON 精简器对损坏值保守保留且对正常值幂等', () => {
  const broken = compactMessageItemsJsonForStorage('{broken');
  assert.deepEqual(broken, { value: '{broken', changed: false, beforeBytes: 7, afterBytes: 7 });

  const original = JSON.stringify([{
    id: 'command-3', type: 'commandExecution', status: 'completed',
    aggregatedOutput: Array.from({ length: 200 }, (_, index) => `第 ${index + 1} 行输出`).join('\n'),
    command: 'echo test',
  }]);
  const first = compactMessageItemsJsonForStorage(original);
  const second = compactMessageItemsJsonForStorage(first.value);
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.value, first.value);
  assert.ok(first.afterBytes < first.beforeBytes);
});
