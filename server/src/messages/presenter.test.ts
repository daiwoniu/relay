import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Message } from '../db/queries.js';
import { presentMessage, presentMessageSummary, presentProcessItem } from './presenter.js';

test('协作结果重复投影保持原结果与名称，过滤未知状态和私有字段', () => {
  const raw={id:'collab-roundtrip',type:'collabAgentToolCall',status:'completed',agentsStates:{child:{status:'completed',message:'done'}}};
  const once=presentProcessItem(raw)!;
  assert.deepEqual(presentProcessItem(once),once);
  const named=presentProcessItem({id:'named',type:'collabAgentToolCall',details:{agentResults:[{threadId:'child',status:'running',name:'review',secret:'discard'},{threadId:'bad',status:'future'}]}})!;
  assert.deepEqual(named.details.agentResults,[{threadId:'child',status:'running',name:'review'}]);
  const mixed=presentProcessItem({id:'mixed',type:'collabAgentToolCall',agentsStates:{child:{status:'completed'}},agentResults:[{threadId:'child',status:'running'},{threadId:'other',status:'running'}]})!;
  assert.deepEqual(mixed.details.agentResults,[{threadId:'child',status:'completed'},{threadId:'other',status:'running'}]);
  assert.deepEqual(presentProcessItem(mixed),mixed);
  assert.deepEqual(presentProcessItem({id:'empty-raw',type:'collabAgentToolCall',agentsStates:{},agentResults:[{threadId:'child',status:'completed'}]})?.details.agentResults,[{threadId:'child',status:'completed'}]);
});

test('保存前保留每个文件的kind.type，明确失败的动态工具不投影为完成', () => {
  const file=presentProcessItem({id:'file-kinds',type:'fileChange',changes:[{path:'a.ts',kind:{type:'add'},diff:'private diff'},{path:'b.ts',kind:{type:'delete'}}]})!;
  assert.deepEqual(file.details.changes,[{path:'a.ts',changeType:'add'},{path:'b.ts',changeType:'delete'}]);
  assert.deepEqual(presentProcessItem({id:'string-kind',type:'fileChange',changes:[{path:'a.ts',changeType:' ',kind:'delete'}]})?.details.changes,[{path:'a.ts',changeType:'delete'}]);
  const failed=presentProcessItem({id:'dynamic',type:'dynamicToolCall',status:'completed',success:false})!;
  assert.equal(failed.status,'incomplete'); assert.equal(failed.details.success,false);
});

test('原生failed事件不能因完成回执或默认值被投影为完成', () => {
  for (const type of ['mcpToolCall', 'commandExecution', 'fileChange']) {
    for (const fallback of ['completed', 'in_progress'] as const) {
      assert.equal(presentProcessItem({id:type,type,status:'failed'}, fallback)?.status, 'incomplete');
      assert.equal(presentProcessItem({id:type,type,details:{status:'failed'}}, fallback)?.status, 'incomplete');
    }
  }
});

test('MCP服务来源与只读标记按实际协议保留，拒绝非名称对象', () => {
  const item=presentProcessItem({id:'actual-mcp',type:'mcpToolCall',status:'completed',server:'xinshu',tool:'data_asset.relationships',readOnlyHint:true});
  assert.equal(item?.details.server,'xinshu');
  assert.equal(item?.details.readOnlyHint,true);
  const invalid=presentProcessItem({id:'bad-mcp',type:'mcpToolCall',status:'completed',server:{env:{SECRET:'not-for-browser'}},readOnlyHint:'true'});
  assert.equal(invalid?.details.server,undefined);
  assert.equal(invalid?.details.readOnlyHint,undefined);
});

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    session_id: 'session-1',
    turn_id: 'turn-1',
    role: 'assistant',
    content: '完成',
    phase: 'final_answer',
    items: null,
    metadata: null,
    created_at: 1,
    duration: null,
    stopped: 0,
    ...overrides,
  };
}

test('新旧独立审批记录都不投影 completed 任务结果，摘要与详情保持一致', () => {
  for (const phase of ['interaction', 'final_answer']) {
    const message = createMessage({ content: '', phase, metadata: '{"outcome":"completed"}',
      items: '[{"id":"approval","type":"interaction","status":"completed"}]' });
    assert.equal(presentMessage(message).outcome, undefined);
    assert.equal(presentMessageSummary(message).outcome, undefined);
    assert.equal(presentMessageSummary(message).historicalOperationRecord, true);
  }
  assert.equal(presentMessage(createMessage({ content: '', phase: 'error', metadata: '{"outcome":"failed"}' })).outcome, 'failed');
});

test('授权摘要标记必须来自已结束 interaction，数量相同的工具或待处理记录不标记', () => {
  const base = { content: '', metadata: '{"outcome":"completed"}' };
  for (const items of [
    [{ id: 'tool', type: 'commandExecution', status: 'completed' }],
    [{ id: 'pending', type: 'interaction', status: 'in_progress' }],
    [{ id: 'approval', type: 'interaction', status: 'completed' }, { id: 'tool', type: 'commandExecution', status: 'completed' }],
    [],
  ]) assert.equal(presentMessageSummary(createMessage({ ...base, items: JSON.stringify(items) })).historicalOperationRecord, false);
  for (const metadata of [{ processContent: 'Narrative' }, { changedFilesIncomplete: true }, { outcome: 'failed' }, { errorCode: 'ERROR' }]) {
    assert.equal(presentMessageSummary(createMessage({ ...base, metadata: JSON.stringify(metadata),
      items: '[{"id":"approval","type":"interaction","status":"completed"}]' })).historicalOperationRecord, false);
  }
});

test('消息 presenter 统一转换 items、metadata 和 stopped', () => {
  const result = presentMessage(createMessage({
    items: JSON.stringify([{ id: 'item-1', type: 'reasoning', status: 'completed', content: '完成分析' }]),
    metadata: JSON.stringify({
      processContent: '思考过程',
      processTimeline: [
        { type: 'narrative', itemId: 'reply-1', content: '思考过程' },
        { type: 'operation', itemId: 'item-1' },
      ],
      attachments: [{
        id: '33333333-3333-4333-8333-333333333333',
        kind: 'host_file',
        name: 'report.txt',
        path: 'C:\\work\\report.txt',
        size: 12,
      }],
    }),
    stopped: 1,
  }));
  assert.deepEqual(result.items, [{
    id: 'item-1',
    type: 'reasoning',
    status: 'completed',
    details: { content: '完成分析' },
  }]);
  assert.equal(result.processContent, '思考过程');
  assert.deepEqual(result.processTimeline, [
    { type: 'narrative', itemId: 'reply-1', content: '思考过程' },
    { type: 'operation', itemId: 'item-1' },
  ]);
  assert.equal(result.stopped, true);
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.attachments?.[0].name, 'report.txt');
  assert.equal(result.executionStage, 'responding');
  assert.equal(Object.hasOwn(result, 'metadata'), false);
});

test('轻量消息 presenter 保留正文终态但跳过重型过程详情', () => {
  const result = presentMessage(createMessage({
    items: JSON.stringify([{ id: 'item-1', type: 'commandExecution', status: 'completed', aggregatedOutput: '大量输出' }]),
    metadata: JSON.stringify({
      processContent: '思考过程',
      processTimeline: [{ type: 'operation', itemId: 'item-1' }],
      changedFiles: [{ path: 'src/app.ts', changeType: 'modified' }],
      changedFilesIncomplete: true,
      outcome: 'completed',
      executionStage: 'responding',
      tokenUsage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 20, reasoningOutputTokens: 4, totalTokens: 30, modelContextWindow: 200000 },
    }),
  }), { includeDetails: false });
  assert.equal(result.content, '完成');
  assert.equal(result.outcome, 'completed');
  assert.equal(result.executionStage, 'responding');
  assert.deepEqual(result.tokenUsage, { inputTokens: 10, cachedInputTokens: 2, outputTokens: 20, reasoningOutputTokens: 4, totalTokens: 30, modelContextWindow: 200000 });
  assert.equal(result.items, undefined);
  assert.equal(result.processContent, undefined);
  assert.equal(result.processTimeline, undefined);
  assert.deepEqual(result.changedFiles, [{ path: 'src/app.ts', changeType: 'modified' }]);
  assert.equal(result.changedFilesIncomplete, true);
});

test('用户消息 presenter 输出严格来源快照且助手消息不输出', () => {
  const origin = {
    senderUserId: 'u1', senderUsername: 'xiang', senderDisplayName: '祥哥', ip: '192.168.1.108', receivedAt: 123,
    client: { source: 'web', deviceType: 'desktop', osName: 'Windows', browserName: 'Edge', relayVersion: '0.19.0' },
  };
  assert.deepEqual(presentMessage(createMessage({
    role: 'user', content: '你好', phase: null, metadata: JSON.stringify({ origin }),
  })).origin, origin);
  assert.equal(presentMessage(createMessage({ metadata: JSON.stringify({ origin }) })).origin, undefined);
});

test('用户消息 presenter 不公开私有浏览器诊断快照', () => {
  const result = presentMessage(createMessage({
    role: 'user', content: '你好', phase: null,
    metadata: JSON.stringify({
      clientDiagnostics: {
        capturedAt: 123,
        userAgent: 'Mozilla/5.0 HuaweiBrowser/6.1.7 Chrome/144.0.0.0',
        standalone: false,
      },
    }),
  }));
  assert.equal(Object.hasOwn(result, 'clientDiagnostics'), false);
  assert.doesNotMatch(JSON.stringify(result), /HuaweiBrowser/);
});

test('消息 summary 使用安全解析后的详情计数并直接返回轻量文件回执', () => {
  const result = presentMessageSummary(createMessage({
    items: JSON.stringify([
      { id: 'item-1', type: 'reasoning', status: 'completed', content: '分析' },
      { type: 'broken' },
    ]),
    metadata: JSON.stringify({
      processTimeline: [{ type: 'narrative', itemId: 'reply-1', content: '过程' }],
      changedFiles: [{ path: 'src/app.ts', changeType: 'modified' }],
      changedFilesIncomplete: true,
    }),
  }));
  assert.equal(result.hasDetails, true);
  assert.equal(result.processItemCount, 1);
  assert.equal(result.processNarrativeCount, 1);
  assert.equal(result.changedFileCount, 1);
  assert.equal(Object.hasOwn(result, 'items'), false);
  assert.equal(Object.hasOwn(result, 'processTimeline'), false);
  assert.deepEqual(result.changedFiles, [{ path: 'src/app.ts', changeType: 'modified' }]);
  assert.equal(result.changedFilesIncomplete, true);
});

test('消息 summary 保留异步问题 ID 供刷新后自动恢复卡片', () => {
  const result = presentMessageSummary(createMessage({
    items: JSON.stringify([
      { id: 'async-question:call-1', type: 'interaction', status: 'in_progress', details: { interactionKind: 'async_question', title: '继续？', questions: [{ title: '继续？', options: ['继续'] }] } },
      { id: 'approval-1', type: 'interaction', status: 'in_progress', details: { interactionKind: 'command_approval' } },
    ]),
  }));
  assert.deepEqual(result.asyncQuestionIds, ['async-question:call-1']);
  assert.equal(Object.hasOwn(result, 'items'), false);
});

test('消息 summary 已直出的文件清单不再单独触发详情加载', () => {
  const result = presentMessageSummary(createMessage({
    metadata: JSON.stringify({
      changedFiles: [{ path: 'src/app.ts', changeType: 'modified' }],
    }),
  }));
  assert.equal(result.hasDetails, false);
  assert.equal(result.processItemCount, 0);
  assert.equal(result.processNarrativeCount, 0);
  assert.equal(result.changedFileCount, 1);
});

test('消息 presenter 对损坏或非数组 items 安全降级', () => {
  assert.equal(presentMessage(createMessage({ items: '{broken' })).items, undefined);
  assert.equal(presentMessage(createMessage({ items: '{"id":"item-1"}' })).items, undefined);
  assert.equal(presentMessage(createMessage()).stopped, false);
});

test('设备上传历史附件按磁盘存在状态返回 available', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-present-upload-'));
  const payload = path.join(root, 'payload.jpg');
  try {
    fs.writeFileSync(payload, 'image');
    const metadata = (filePath: string) => JSON.stringify({ attachments: [{
      id: '55555555-5555-4555-8555-555555555555', kind: 'uploaded_file', name: 'photo.jpg',
      path: filePath, size: 5, mimeType: 'image/jpeg', available: true,
    }] });
    const available = presentMessage(createMessage({ metadata: metadata(payload) })).attachments?.[0];
    assert.equal(available?.kind, 'uploaded_file');
    if (available?.kind === 'uploaded_file') assert.equal(available.available, true);
    fs.rmSync(payload);
    const removed = presentMessage(createMessage({ metadata: metadata(payload) })).attachments?.[0];
    if (removed?.kind === 'uploaded_file') assert.equal(removed.available, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('错误阶段消息输出持久化失败气泡标记', () => {
  const result = presentMessage(createMessage({
    content: 'Codex 连接在任务完成前断开',
    phase: 'error',
  }));
  assert.equal(result.isError, true);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorMessage, 'Codex 连接在任务完成前断开');
  assert.equal(presentMessage(createMessage()).isError, undefined);
});

test('消息 presenter 输出显式执行阶段、终态和错误代码', () => {
  const result = presentMessage(createMessage({
    content: '部分回答',
    metadata: JSON.stringify({
      executionStage: 'responding',
      outcome: 'interrupted',
      errorCode: 'RELAY_RESTARTED',
      errorMessage: 'Relay 服务重启',
    }),
  }));
  assert.equal(result.executionStage, 'responding');
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.errorCode, 'RELAY_RESTARTED');
  assert.equal(result.errorMessage, 'Relay 服务重启');
});

test('消息 presenter 输出持久化的修改文件回执', () => {
  const result = presentMessage(createMessage({
    metadata: JSON.stringify({
      changedFiles: [
        { path: 'src/app.ts', changeType: 'modified' },
        { path: 'src/old.ts', changeType: 'deleted' },
      ],
    }),
  }));
  assert.deepEqual(result.changedFiles, [
    { path: 'src/app.ts', changeType: 'modified' },
    { path: 'src/old.ts', changeType: 'deleted' },
  ]);
});

test('历史消息可从已存命令项恢复文件回执可能不完整事实', () => {
  const result = presentMessageSummary(createMessage({
    items: JSON.stringify([{
      id: 'command-1', type: 'commandExecution', status: 'completed', exitCode: 0,
      command: 'python scripts/task_registry.py generate',
    }]),
  }));
  assert.equal(result.changedFilesIncomplete, true);
});

test('消息 presenter 忽略缺少稳定 id 的处理项并兼容已包装 DTO', () => {
  const wrapped = {
    id: 'item-2',
    type: 'commandExecution',
    status: 'completed' as const,
    raw: { id: 'item-2', type: 'commandExecution', status: 'completed', command: 'npm test', secret: '不得输出' },
  };
  const result = presentMessage(createMessage({
    items: JSON.stringify([{ type: 'reasoning', status: 'completed' }, wrapped]),
  }));
  assert.deepEqual(result.items, [{
    id: 'item-2',
    type: 'commandExecution',
    status: 'completed',
    details: { command: 'npm test' },
  }]);
  assert.deepEqual(presentProcessItem({ id: 'item-3', type: 'webSearch' }, 'in_progress'), {
    id: 'item-3',
    type: 'webSearch',
    status: 'in_progress',
    details: {},
  });
});

test('处理项 details 对嵌套命令、文件和计划字段继续执行白名单', () => {
  assert.deepEqual(presentProcessItem({
    id: 'item-4',
    type: 'plan',
    status: 'completed',
    commandActions: [{ command: 'npm test', environment: { TOKEN: 'secret' } }],
    changes: [{ path: 'src/app.ts', diff: '不得输出' }],
    plan: [{ step: '验证计划', status: 'pending', secret: '不得输出' }],
  }), {
    id: 'item-4',
    type: 'plan',
    status: 'completed',
    details: {
      commandActions: [{ command: 'npm test' }],
      changes: [{ path: 'src/app.ts' }],
      planCount: 1,
      plan: [{ step: '验证计划', status: 'pending' }],
    },
  });
});

test('协作代理完成结果经过白名单后进入处理项详情', () => {
  assert.deepEqual(presentProcessItem({
    id: 'collab-1',
    type: 'collabAgentToolCall',
    status: 'completed',
    tool: 'spawnAgent',
    prompt: '并行检查通知行为',
    agentsStates: {
      'thread-child': {
        status: 'completed',
        message: '检查完成\n未发现其他问题',
        secret: '不得输出',
      },
      broken: 'invalid',
    },
  }), {
    id: 'collab-1',
    type: 'collabAgentToolCall',
    status: 'completed',
    details: {
      tool: 'spawnAgent',
      prompt: '并行检查通知行为',
      agentResults: [{
        threadId: 'thread-child',
        status: 'completed',
        message: '检查完成\n未发现其他问题',
      }],
    },
  });
});

test('子代理活动保留任务路径和线程标识用于展示任务名', () => {
  assert.deepEqual(presentProcessItem({
    id: 'activity-1',
    type: 'subAgentActivity',
    status: 'completed',
    kind: 'started',
    agentThreadId: 'thread-child',
    agentPath: '/root/long_description_preview',
    secret: '不得输出',
  }), {
    id: 'activity-1',
    type: 'subAgentActivity',
    status: 'completed',
    details: {
      kind: 'started',
      agentThreadId: 'thread-child',
      agentPath: '/root/long_description_preview',
    },
  });
});
