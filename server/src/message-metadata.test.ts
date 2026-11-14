import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMessageMetadata, serializeMessageMetadata } from './message-metadata.js';

test('explicit async-question reply keeps its question id; ordinary messages do not', () => {
  const reply = serializeMessageMetadata({ replyToAsyncQuestionId: 'async-question:call-1' });
  assert.equal(parseMessageMetadata(reply).replyToAsyncQuestionId, 'async-question:call-1');
  assert.equal(parseMessageMetadata(serializeMessageMetadata({})).replyToAsyncQuestionId, undefined);
  assert.equal(parseMessageMetadata('{"replyToAsyncQuestionId":""}').replyToAsyncQuestionId, undefined);
});

test('过程回复可以写入并读回消息元数据', () => {
  const metadata = serializeMessageMetadata('  正在查看文件\n准备执行脚本  ');
  assert.deepEqual(parseMessageMetadata(metadata), {
    processContent: '正在查看文件\n准备执行脚本',
  });
});

test('空值和损坏的消息元数据安全返回空对象', () => {
  assert.equal(serializeMessageMetadata('   '), null);
  assert.deepEqual(parseMessageMetadata(null), {});
  assert.deepEqual(parseMessageMetadata('{broken'), {});
});

test('严格过程时间线可以写入并读回且过滤损坏条目', () => {
  const metadata = serializeMessageMetadata({
    processContent: '回复 A\n\n回复 B',
    processTimeline: [
      { type: 'narrative', itemId: 'reply-a', content: '回复 A' },
      { type: 'operation', itemId: 'command-a' },
    ],
  });
  const parsed = JSON.parse(metadata || '{}');
  parsed.processTimeline.push({ type: 'operation', itemId: '' });
  assert.deepEqual(parseMessageMetadata(JSON.stringify(parsed)).processTimeline, [
    { type: 'narrative', itemId: 'reply-a', content: '回复 A' },
    { type: 'operation', itemId: 'command-a' },
  ]);
});

test('消息执行阶段、终态和错误信息可以写入并读回', () => {
  const metadata = serializeMessageMetadata({
    executionStage: 'responding',
    outcome: 'failed',
    errorCode: 'CODEX_CONNECTION_CLOSED',
    errorMessage: 'Codex 连接已断开',
  });
  assert.deepEqual(parseMessageMetadata(metadata), {
    executionStage: 'responding',
    outcome: 'failed',
    errorCode: 'CODEX_CONNECTION_CLOSED',
    errorMessage: 'Codex 连接已断开',
  });
});

test('消息可以写入并读回本轮 token 用量', () => {
  const tokenUsage = {
    inputTokens: 126148,
    cachedInputTokens: 125440,
    outputTokens: 10,
    reasoningOutputTokens: 0,
    totalTokens: 126158,
    modelContextWindow: 353400,
  };
  const metadata = serializeMessageMetadata({ outcome: 'completed', tokenUsage });
  assert.deepEqual(parseMessageMetadata(metadata), { outcome: 'completed', tokenUsage });
});

test('消息可以写入并过滤本轮修改文件回执', () => {
  const metadata = serializeMessageMetadata({
    changedFilesIncomplete: true,
    changedFiles: [
      { path: 'src/app.ts', changeType: 'modified', size: 2048 },
      { path: 'src/new.ts', changeType: 'added' },
      { path: 'E:\\office\\outside.txt', changeType: 'modified', size: 12, external: true },
      { path: '', changeType: 'deleted' },
    ],
  });
  const parsed = JSON.parse(metadata || '{}');
  parsed.changedFiles.push({ path: 'src/broken.ts', changeType: 'unknown' });
  const result = parseMessageMetadata(JSON.stringify(parsed));
  assert.equal(result.changedFilesIncomplete, true);
  assert.deepEqual(result.changedFiles, [
    { path: 'src/app.ts', changeType: 'modified', size: 2048 },
    { path: 'src/new.ts', changeType: 'added' },
    { path: 'E:\\office\\outside.txt', changeType: 'modified', size: 12, external: true },
  ]);
  assert.equal(parseMessageMetadata(JSON.stringify({ changedFilesIncomplete: 'true' })).changedFilesIncomplete, undefined);
});

test('消息可以写入主机附件且不会接受访问令牌字段', () => {
  const metadata = serializeMessageMetadata({ attachments: [{
    id: '33333333-3333-4333-8333-333333333333', kind: 'host_file', name: 'report.txt', path: 'C:\\work\\report.txt', size: 12,
  }] });
  assert.deepEqual(parseMessageMetadata(metadata).attachments, [{
    id: '33333333-3333-4333-8333-333333333333', kind: 'host_file', name: 'report.txt', path: 'C:\\work\\report.txt', size: 12,
  }]);
  assert.equal(metadata?.includes('accessToken'), false);
});

test('消息可以写入设备上传附件且不保留草稿能力字段', () => {
  const metadata = serializeMessageMetadata({ attachments: [{
    id: '55555555-5555-4555-8555-555555555555', kind: 'uploaded_file', name: 'photo.jpg',
    path: 'D:\\project\\.relay_upload\\messages\\id\\payload.jpg', size: 12,
    mimeType: 'image/jpeg', available: true,
  }] });
  assert.equal(parseMessageMetadata(metadata).attachments?.[0].kind, 'uploaded_file');
  assert.equal(metadata?.includes('uploadId'), false);
  assert.equal(metadata?.includes('projectId'), false);
});

test('消息模型快照严格白名单化并保留 requested/effective', () => {
  const serialized = serializeMessageMetadata({
    modelInfo: {
      engineId: 'codex',
      requested: { id: 'gpt-requested', reasoningEffort: 'high' },
      effective: { id: 'gpt-effective', displayName: 'GPT Effective', provider: 'OpenAI' },
      serviceTier: 'priority',
      resolvedServiceTier: 'priority',
      rerouted: true,
    },
  });
  assert.deepEqual(parseMessageMetadata(serialized).modelInfo, {
    engineId: 'codex',
    requested: { id: 'gpt-requested', reasoningEffort: 'high' },
    effective: { id: 'gpt-effective', displayName: 'GPT Effective', provider: 'OpenAI' },
    serviceTier: 'priority',
    resolvedServiceTier: 'priority',
    rerouted: true,
  });
  assert.equal(parseMessageMetadata(JSON.stringify({
    modelInfo: {
      engineId: 'codex', effective: { id: 'gpt', displayName: 'GPT', endpoint: 'secret' }, rerouted: false,
    },
  })).modelInfo, undefined);
});

test('用户消息来源可以严格写入并读回', () => {
  const origin = {
    senderUserId: 'u1', senderUsername: 'xiang', senderDisplayName: '祥哥',
    ip: '192.168.1.108', receivedAt: 123,
    client: { source: 'web' as const, deviceType: 'desktop' as const, osName: 'Windows', browserName: 'Edge', relayVersion: '0.19.0' },
  };
  assert.deepEqual(parseMessageMetadata(serializeMessageMetadata({ origin })).origin, origin);
  assert.equal(parseMessageMetadata(JSON.stringify({ origin: { ...origin, token: 'secret' } })).origin, undefined);
});

test('浏览器诊断快照作为私有 metadata 严格写入并读回', () => {
  const clientDiagnostics = {
    capturedAt: 123,
    userAgent: 'Mozilla/5.0 HuaweiBrowser/6.1.7 Chrome/144.0.0.0',
    standalone: false,
    languages: ['zh-CN'],
    screen: { width: 1260, height: 2720, devicePixelRatio: 3 },
  };
  assert.deepEqual(
    parseMessageMetadata(serializeMessageMetadata({ clientDiagnostics })).clientDiagnostics,
    clientDiagnostics,
  );
  assert.equal(parseMessageMetadata(JSON.stringify({
    clientDiagnostics: { ...clientDiagnostics, localStorage: { token: 'secret' } },
  })).clientDiagnostics, undefined);
});
