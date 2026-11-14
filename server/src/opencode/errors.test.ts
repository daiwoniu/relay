import assert from 'node:assert/strict';
import test from 'node:test';
import { mapOpenCodeError } from './errors.js';

test('OpenCode 兜底错误完整保留经过安全清理的 provider 原始异常文本', () => {
  const original = 'AI_APICallError: auth_unavailable: no auth available (providers=codex, model=gpt-5.6-sol; last upstream error: server_is_overloaded: Our servers are currently overloaded.)';
  const diagnostic = mapOpenCodeError(new Error(original));

  assert.equal(diagnostic.code, undefined);
  assert.equal(diagnostic.userMessage, 'OpenCode 服务执行失败');
  assert.equal(diagnostic.originalMessage, original);
  assert.ok((diagnostic.technicalSummary?.length || 0) <= 500);
});

test('OpenCode 原始异常保留完整原文（不做脱敏）', () => {
  const diagnostic = mapOpenCodeError(new Error('provider failed C:\\Users\\demo\\config.json token=secret-value'));

  assert.match(diagnostic.originalMessage || '', /provider failed/);
  assert.match(diagnostic.originalMessage || '', /Users\\demo|secret-value/);
  assert.doesNotMatch(diagnostic.technicalSummary || '', /Users\\demo|secret-value/);
  assert.equal(diagnostic.code, undefined);
});

test('OpenCode 无消息的错误不回退成干扰文案', () => {
  const diagnostic = mapOpenCodeError(undefined);

  assert.equal(diagnostic.originalMessage, undefined);
  assert.equal(diagnostic.code, undefined);
  assert.equal(diagnostic.userMessage, 'OpenCode 服务执行失败');
});