import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCodexError } from './diagnostics.js';

test('Codex 保留稳定错误码并脱敏技术摘要', () => {
  const diagnostic = classifyCodexError({
    code: 'CODEX_THREAD_ARCHIVED',
    message: '线程已归档',
    detail: 'Authorization=secret C:\\Users\\demo\\config.json',
  }, { phase: 'recovery' });
  assert.equal(diagnostic.code, 'CODEX_THREAD_ARCHIVED');
  assert.equal(diagnostic.userMessage, '该会话已在 ChatGPT/Codex 中归档，请在会话菜单中选择“取消归档”后重试。');
  assert.doesNotMatch(diagnostic.technicalSummary || '', /secret|Users\\demo/);
});

test('Codex 缺失稳定错误码时按阶段分类', () => {
  const connect = classifyCodexError(new Error('socket failed C:\\Users\\demo\\secret.txt'), { phase: 'connect' });
  assert.equal(connect.code, 'CODEX_CONNECT_FAILED');
  assert.equal(connect.userMessage, 'Codex 服务执行失败');
  assert.doesNotMatch(connect.technicalSummary || '', /Users\\demo/);
  assert.equal(classifyCodexError(new Error('bad frame'), { phase: 'protocol' }).code, 'CODEX_PROTOCOL_ERROR');
});

test('Codex 不把带稳定错误码的原始异常内容作为用户文案', () => {
  const diagnostic = classifyCodexError({
    code: 'CODEX_INIT_FAILED',
    message: '初始化失败 C:\\Users\\demo\\config.json token=secret-value',
  }, { phase: 'connect' });
  assert.equal(diagnostic.userMessage, 'Codex 初始化失败');
  assert.doesNotMatch(diagnostic.userMessage, /Users|secret-value/);
  assert.doesNotMatch(diagnostic.technicalSummary || '', /Users\\demo|secret-value/);
});

test('Codex 完整保留经过安全清理的 provider 原始异常文本', () => {
  const original = `unexpected status 503 Service Unavailable: auth_unavailable: ${'detail-'.repeat(100)}`;
  const diagnostic = classifyCodexError({
    code: 'CODEX_OTHER',
    message: original,
  }, { phase: 'provider' });

  assert.equal(diagnostic.originalMessage, original);
  assert.ok((diagnostic.technicalSummary?.length || 0) <= 500);
  assert.equal(diagnostic.userMessage, 'Codex 服务执行失败');
});

test('Codex 原始异常保留完整原文（不做脱敏）但技术摘要仍保留结构化错误信息', () => {
  const diagnostic = classifyCodexError({
    code: 'CODEX_OTHER',
    message: '{"apiKey":"secret-value","reason":"provider failed"}',
  }, { phase: 'provider' });

  assert.match(diagnostic.originalMessage || '', /secret-value/);
  assert.match(diagnostic.originalMessage || '', /provider failed/);
  assert.match(diagnostic.technicalSummary || '', /CODEX_OTHER/);
});

test('Codex provider 阶段无稳定错误码时不编造错误码', () => {
  const diagnostic = classifyCodexError(new Error('upstream 503 secret-token'), { phase: 'provider' });
  assert.equal(diagnostic.code, undefined);
  assert.equal(diagnostic.phase, 'provider');
  assert.equal(diagnostic.userMessage, 'Codex 服务执行失败');
  assert.doesNotMatch(diagnostic.technicalSummary || '', /token=|secret-value/);
});

test('Codex 按稳定错误码推导真实诊断阶段', () => {
  assert.equal(classifyCodexError({ code: 'CODEX_CONNECTION_TIMEOUT', message: 'timeout' }, { phase: 'provider' }).phase, 'connect');
  assert.equal(classifyCodexError({ code: 'RESTART_RECOVERY_FAILED', message: 'failed' }, { phase: 'provider' }).phase, 'recovery');
  assert.equal(classifyCodexError({ code: 'CODEX_RESPONSE_STREAM_DISCONNECTED', message: 'failed' }, { phase: 'provider' }).phase, 'stream');
});

test('Codex 仅把最终限流与过载归为容量错误', () => {
  assert.equal(classifyCodexError({ code: 'CODEX_USAGE_LIMIT_EXCEEDED', message: 'limit', retryAfterMs: 12_000 }, { phase: 'provider' }).providerClass, 'rate_limit');
  assert.equal(classifyCodexError({ code: 'CODEX_SERVER_OVERLOADED', message: 'busy' }, { phase: 'provider' }).providerClass, 'overloaded');
  assert.equal(classifyCodexError({ code: 'CODEX_CONNECTION_ERROR', message: 'closed' }, { phase: 'provider' }).providerClass, 'unavailable');
});
