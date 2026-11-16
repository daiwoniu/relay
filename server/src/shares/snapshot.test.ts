import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../db/queries.js';
import { buildShareSnapshot, readShareSnapshot } from './snapshot.js';

function message(overrides: Partial<Message> & Pick<Message, 'id' | 'role' | 'content' | 'created_at'>): Message {
  return {
    session_id: 'session-1', turn_id: 'turn-1', phase: null, items: null, metadata: null,
    duration: null, stopped: 0, ...overrides,
  };
}

const messages: Message[] = [
  message({ id: 'user-1', role: 'user', content: '问题一', created_at: 1 }),
  message({
    id: 'assistant-1', role: 'assistant', content: '回答一', created_at: 2,
    items: JSON.stringify([{ id: 'tool-1', type: 'command', status: 'completed', details: {
      command: 'git status', output: 'ok', result: { content: 'safe', accessToken: 'secret', arbitrary: 'drop' }, accessToken: 'secret', requestId: 'request-secret', unknown: 'drop',
    } }]),
    metadata: JSON.stringify({
      outcome: 'completed', processContent: '处理过程',
      processTimeline: [{ type: 'narrative', itemId: 'narrative-1', content: '分析' }, { type: 'operation', itemId: 'tool-1' }],
      changedFiles: [{ path: 'src/app.ts', changeType: 'modified' }],
      changedFilesIncomplete: true,
    }),
  }),
  message({ id: 'user-2', role: 'user', content: '问题二', created_at: 3 }),
];

test('使用最后一条已完成助手回复作为截止线', () => {
  const snapshot = buildShareSnapshot(messages, { scope: 'session', includeProcess: false });
  assert.deepEqual(snapshot.messages.map((entry) => entry.id), ['user-1', 'assistant-1']);
  assert.throws(
    () => buildShareSnapshot(messages, { scope: 'single', includeProcess: false, messageIds: ['user-2'] }),
    /截止线/,
  );
});

test('公开分享不包含用户消息来源信息和私有浏览器诊断快照', () => {
  const sourceMessages = messages.map((entry) => entry.id === 'user-1' ? {
    ...entry,
    metadata: JSON.stringify({
      origin: {
        senderUserId: 'u1', senderUsername: 'xiang', senderDisplayName: '祥哥', ip: '192.168.1.108', receivedAt: 123,
        client: { source: 'web', deviceType: 'desktop', relayVersion: '0.19.0' },
      },
      clientDiagnostics: {
        capturedAt: 123,
        userAgent: 'Mozilla/5.0 HuaweiBrowser/6.1.7 Chrome/144.0.0.0',
        standalone: false,
      },
    }),
  } : entry);
  const snapshot = buildShareSnapshot(sourceMessages, { scope: 'session', includeProcess: false });
  assert.equal(Object.hasOwn(snapshot.messages[0] || {}, 'origin'), false);
  assert.equal(JSON.stringify(snapshot).includes('192.168.1.108'), false);
  assert.equal(JSON.stringify(snapshot).includes('HuaweiBrowser'), false);
});

test('公开分享保留安全模型事实且未知私有字段不会进入快照', () => {
  const withModel = messages.map((entry) => entry.id === 'assistant-1' ? {
    ...entry,
    metadata: JSON.stringify({
      outcome: 'completed',
      modelInfo: {
        engineId: 'codex',
        requested: { id: 'gpt-requested' },
        effective: { id: 'gpt-effective', displayName: 'GPT Effective', provider: 'OpenAI' },
        rerouted: true,
      },
      endpoint: 'https://secret.example',
    }),
  } : entry);
  const snapshot = buildShareSnapshot(withModel, { scope: 'session', includeProcess: false });
  const serialized = JSON.stringify(snapshot);
  assert.match(serialized, /gpt-effective/);
  assert.doesNotMatch(serialized, /secret\.example/);
});

test('乱序选择仍按原始消息顺序生成快照', () => {
  const snapshot = buildShareSnapshot(messages, {
    scope: 'selection', includeProcess: false, messageIds: ['assistant-1', 'user-1'],
  });
  assert.deepEqual(snapshot.messages.map((entry) => entry.id), ['user-1', 'assistant-1']);
});

test('没有已完成助手回复时拒绝创建', () => {
  assert.throws(
    () => buildShareSnapshot([message({ id: 'user-only', role: 'user', content: '问题', created_at: 1 })], { scope: 'session', includeProcess: false }),
    /没有可分享/,
  );
});

test('关闭处理过程时移除全部过程字段', () => {
  const assistant = buildShareSnapshot(messages, { scope: 'single', includeProcess: false, messageIds: ['assistant-1'] }).messages[0];
  assert.equal(assistant.processContent, undefined);
  assert.equal(assistant.processItems, undefined);
  assert.equal(assistant.processTimeline, undefined);
  assert.equal(assistant.changedFiles, undefined);
  assert.equal(assistant.changedFilesIncomplete, undefined);
});

test('分享保留范围、过程选择和回合关联，授权结果与实测时间不丢失', () => {
  const snapshot = buildShareSnapshot([message({
    id: 'approval-reply', role: 'assistant', content: '完成', turn_id: 'turn-share', created_at: 2,
    items: JSON.stringify([{ id: 'approval', type: 'interaction', status: 'completed', details: {
      title: '命令授权', interactionKind: 'command_approval', resolvedAction: 'decline',
      decisionSource: 'user', effectiveScope: null, trustExpiresAt: null, decidedAt: 20,
      firstObservedAt: 10, completedObservedAt: 20, requestId: 'private',
    } }]),
  })], { scope: 'session', includeProcess: true });
  assert.equal(snapshot.scope, 'session');
  assert.equal(snapshot.includeProcess, true);
  assert.equal(snapshot.messages[0].turnId, 'turn-share');
  const details = snapshot.messages[0].processItems![0].details;
  assert.equal(details.resolvedAction, 'decline');
  assert.equal(details.interactionKind, 'command_approval');
  assert.equal(details.decisionSource, 'user');
  assert.equal(details.effectiveScope, null);
  assert.equal(details.decidedAt, 20);
  assert.equal(details.firstObservedAt, 10);
  assert.equal(details.completedObservedAt, 20);
  assert.equal(details.requestId, undefined);
});

test('开启处理过程时只保留展示字段并清除敏感和可执行信息', () => {
  const assistant = buildShareSnapshot(messages, { scope: 'single', includeProcess: true, messageIds: ['assistant-1'] }).messages[0];
  assert.equal(assistant.processContent, '处理过程');
  assert.deepEqual(assistant.processItems?.[0].details, { command: 'git status', output: 'ok', result: { content: 'safe' } });
  assert.deepEqual(assistant.processTimeline, [
    { type: 'narrative', itemId: 'narrative-1', content: '分析' },
    { type: 'operation', itemId: 'tool-1' },
  ]);
  assert.deepEqual(assistant.changedFiles, [{ path: 'src/app.ts', changeType: 'modified' }]);
  assert.equal(assistant.changedFilesIncomplete, true);
});

test('公开分享保留精简输出摘要字段', () => {
  const snapshot = buildShareSnapshot([
    message({ id: 'user-summary', role: 'user', content: '执行', created_at: 1 }),
    message({
      id: 'assistant-summary', role: 'assistant', content: '完成', created_at: 2,
      items: JSON.stringify([{
        id: 'command-summary', type: 'commandExecution', status: 'completed', details: {
          command: 'npm test',
          outputSummary: {
            source: 'aggregatedOutput', lineCount: 20, charCount: 1024,
            firstLine: '第一行', lastLine: '最后一行', truncated: true, secret: 'drop',
          },
        },
      }]),
      metadata: JSON.stringify({ outcome: 'completed' }),
    }),
  ], { scope: 'session', includeProcess: true });

  assert.deepEqual(snapshot.messages[1].processItems?.[0].details.outputSummary, {
    source: 'aggregatedOutput', lineCount: 20, charCount: 1024,
    firstLine: '第一行', lastLine: '最后一行', truncated: true,
  });
});

test('公开分享保留外部文件变更但移除宿主机绝对目录', () => {
  const snapshot = buildShareSnapshot([
    message({ id: 'user-external', role: 'user', content: '修改外部文件', created_at: 1 }),
    message({
      id: 'assistant-external', role: 'assistant', content: '已修改', created_at: 2,
      items: JSON.stringify([{
        id: 'external-change',
        type: 'fileChange',
        status: 'completed',
        details: { changes: [{ path: 'E:\\office\\projects\\outside.txt', changeType: 'modified' }] },
      }]),
      metadata: JSON.stringify({
        outcome: 'completed',
        changedFiles: [{
          path: 'E:\\office\\projects\\outside.txt',
          changeType: 'modified',
          size: 12,
          external: true,
        }],
      }),
    }),
  ], { scope: 'session', includeProcess: true });
  assert.deepEqual(snapshot.messages[1].changedFiles, [{
    path: '外部文件/outside.txt', changeType: 'modified', size: 12,
  }]);
  assert.deepEqual(snapshot.messages[1].processItems?.[0].details, {
    changes: [{ path: '文件/outside.txt', changeType: 'modified' }],
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /E:\\\\office|projects/);
});

test('公开分享脱敏 Agent Teams 路径且不依赖过程项类型', () => {
  const snapshot = buildShareSnapshot([
    message({ id: 'user-agent', role: 'user', content: '启动子任务', created_at: 1 }),
    message({
      id: 'assistant-agent', role: 'assistant', content: '已完成', created_at: 2,
      items: JSON.stringify([
        {
          id: 'agent-win', type: 'collabAgentToolCall', status: 'completed',
          details: { agentName: '研究员', agentPath: 'D:\\secret\\team\\agent-1', summary: '完成' },
        },
        {
          id: 'agent-unix', type: 'subAgentActivity', status: 'completed',
          details: { agentPath: '/Users/alice/private/agent-2' },
        },
        {
          id: 'agent-unc', type: 'subAgentActivity', status: 'completed',
          details: { agentPath: '\\\\server\\private\\agent-3' },
        },
      ]),
      metadata: JSON.stringify({ outcome: 'completed' }),
    }),
  ], { scope: 'session', includeProcess: true, sourceEngine: 'codebuddy' });

  assert.deepEqual(snapshot.messages[1].processItems?.map((item) => item.details.agentPath), [
    '文件/agent-1', '文件/agent-2', '文件/agent-3',
  ]);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /D:\\\\secret/);
  assert.doesNotMatch(serialized, /Users.*alice/);
  assert.doesNotMatch(serialized, /server.*private/);
});

test('V1 快照通过显式版本适配入口读取', () => {
  const snapshot = buildShareSnapshot(messages, { scope: 'session', includeProcess: false });
  assert.deepEqual(readShareSnapshot(1, JSON.stringify(snapshot)), snapshot);
  assert.throws(() => readShareSnapshot(2, JSON.stringify(snapshot)), /不支持/);
});

test('读取升级前的历史快照时再次脱敏 Codex 文件指令', () => {
  const snapshot = buildShareSnapshot(messages, { scope: 'session', includeProcess: false });
  snapshot.messages[1].content = '查看 :codex-file-citation{path="C:\\Users\\me\\secret.docx" purpose="output"}';
  const restored = readShareSnapshot(1, JSON.stringify(snapshot));
  assert.equal(restored.messages[1].content, '查看 [文件：secret.docx]');
  assert.doesNotMatch(JSON.stringify(restored), /C:\\\\Users/);
});

test('分享快照保存来源引擎且旧快照默认按 Codex 读取', () => {
  const snapshot = buildShareSnapshot(messages, {
    scope: 'session', includeProcess: false, sourceEngine: 'codebuddy',
  });
  assert.equal(snapshot.sourceEngine, 'codebuddy');
  const legacy = readShareSnapshot(1, JSON.stringify({ version: 1, messages: snapshot.messages }));
  assert.equal(legacy.sourceEngine, 'codex');
});

test('公开分享只保留主机附件摘要并移除绝对路径', () => {
  const snapshot = buildShareSnapshot([
    message({
      id: 'user-attachment', role: 'user', content: '', created_at: 1,
      metadata: JSON.stringify({ attachments: [{
        id: '33333333-3333-4333-8333-333333333333', kind: 'host_file', name: 'report.txt', path: 'C:\\secret\\report.txt', size: 12,
      }] }),
    }),
    message({ id: 'assistant-attachment', role: 'assistant', content: '已查看', created_at: 2 }),
  ], { scope: 'session', includeProcess: false });
  assert.deepEqual(snapshot.messages[0].attachments, [{
    id: '33333333-3333-4333-8333-333333333333', kind: 'host_file', name: 'report.txt', size: 12,
  }]);
  assert.doesNotMatch(JSON.stringify(snapshot), /C:\\\\secret|accessToken/);
});

test('公开分享保留设备上传摘要但不暴露路径', () => {
  const snapshot = buildShareSnapshot([
    message({
      id: 'user-upload', role: 'user', content: '', created_at: 1,
      metadata: JSON.stringify({ attachments: [{
        id: '55555555-5555-4555-8555-555555555555', kind: 'uploaded_file', name: 'photo.jpg',
        path: 'D:\\secret\\payload.jpg', size: 12, mimeType: 'image/jpeg', available: true,
      }] }),
    }),
    message({ id: 'assistant-upload', role: 'assistant', content: '已查看', created_at: 2 }),
  ], { scope: 'session', includeProcess: false });
  assert.deepEqual(snapshot.messages[0].attachments, [{
    id: '55555555-5555-4555-8555-555555555555', kind: 'uploaded_file', name: 'photo.jpg',
    size: 12, mimeType: 'image/jpeg', available: false,
  }]);
  assert.doesNotMatch(JSON.stringify(snapshot), /D:\\\\secret|uploadId|projectId/);
});

test('公开分享将 Codex 文件指令替换为无路径静态标签', () => {
  const content = [
    '文档 :codex-file-citation{path="D:\\private\\launch-plan.docx" purpose="output" artifact_kind="document" page_number="4"}',
    '::codex-inline-vis{file="D:\\private\\charts\\summary.html"}',
    '::artifact-template{skill_name="artifact-template-brief" skill_directory="C:\\Users\\me\\skills\\brief" display_name="项目简报" artifact_kind="document"}',
  ].join('\n\n');
  const snapshot = buildShareSnapshot([
    message({ id: 'user-directives', role: 'user', content: '查看结果', created_at: 1 }),
    message({ id: 'assistant-directives', role: 'assistant', content, created_at: 2 }),
  ], { scope: 'session', includeProcess: false });
  assert.equal(snapshot.messages[1].content, [
    '文档 [文件：launch-plan.docx]',
    '[可视化：summary.html]',
    '[模板：项目简报]',
  ].join('\n\n'));
  assert.doesNotMatch(JSON.stringify(snapshot), /D:\\\\private|C:\\\\Users|skill_directory|codex-inline-vis/);
});
