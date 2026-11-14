import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ENGINE_ERROR_MESSAGE_LENGTH,
  getTerminalCapacityFailure,
  sanitizeEngineErrorMessage,
  sanitizeTechnicalSummary,
} from './diagnostics.js';

test('技术摘要脱敏凭据、绝对路径并限制长度', () => {
  const summary = sanitizeTechnicalSummary(new Error(`token=abc123 password=hunter2 C:\\Users\\demo\\secret.txt ${'x'.repeat(800)}`));
  assert(summary);
  assert.doesNotMatch(summary, /abc123|hunter2|Users\\demo/);
  assert.match(summary, /\[REDACTED\]|\[PATH\]/);
  assert.ok(summary.length <= 500);
});

test('技术摘要递归脱敏 JSON 凭据、URL 参数与 UNC 路径', () => {
  const summary = sanitizeTechnicalSummary({
    config: {
      password: 'hunter2',
      nested: { apiKey: 'json-secret', refreshToken: 'refresh-secret' },
    },
    message: '请求 https://example.test/run?token=url-secret 失败，配置位于 \\\\server\\share\\relay.json',
  });
  assert(summary);
  assert.doesNotMatch(summary, /hunter2|json-secret|refresh-secret|url-secret|server\\share/);
  assert.match(summary, /\[REDACTED\]|\[PATH\]/);
});

test('可展示原始异常完整保留 header、JSON、URL 和私钥原文（仅移除终端控制符）', () => {
  const structuredSecret = JSON.stringify({ apiKey: 'json-"secret', nested: { refreshToken: 'refresh-secret' }, reason: 'provider failed' });
  const sanitized = [
    sanitizeEngineErrorMessage('Authorization: Bearer abc.def.ghi'),
    sanitizeEngineErrorMessage(structuredSecret),
    sanitizeEngineErrorMessage('https://demo:hunter2@example.test/run?access_token=url-secret'),
    sanitizeEngineErrorMessage('-----BEGIN PRIVATE KEY-----\nprivate-secret\n-----END PRIVATE KEY-----'),
  ].join('\n');

  assert.match(sanitized, /abc\.def\.ghi/);
  assert.match(sanitized, /json-\\?"secret/);
  assert.match(sanitized, /refresh-secret/);
  assert.match(sanitized, /hunter2/);
  assert.match(sanitized, /url-secret/);
  assert.match(sanitized, /private-secret/);
  assert.match(sanitized, /provider failed/);

  const summary = sanitizeTechnicalSummary({ code: 'FAILED', message: structuredSecret });
  assert.doesNotMatch(summary || '', /json-\\?"secret|refresh-secret/);
  assert.match(summary || '', /provider failed/);
});

test('可展示原始异常移除终端控制符并显式限制长度', () => {
  const bidi = '\u202E';
  const sanitized = sanitizeEngineErrorMessage(`\u001b[31m失败\u001b[0m${bidi}\u0000${'x'.repeat(MAX_ENGINE_ERROR_MESSAGE_LENGTH * 2)}`);

  assert.doesNotMatch(sanitized, /\u001b|\u202E|\u0000/);
  assert.ok(sanitized.length <= MAX_ENGINE_ERROR_MESSAGE_LENGTH);
  assert.match(sanitized, /\[原始异常过长，已安全截断\]$/);
});

test('只有最终限流与过载诊断形成 Provider 冷却事实', () => {
  const base = { code: 'TEST', phase: 'provider' as const, retryable: true, userMessage: 'test' };
  assert.deepEqual(getTerminalCapacityFailure({ ...base, providerClass: 'rate_limit', retryAfterMs: 5_000 }), { retryAfterMs: 5_000 });
  assert.deepEqual(getTerminalCapacityFailure({ ...base, providerClass: 'overloaded' }), { retryAfterMs: null });
  assert.equal(getTerminalCapacityFailure({ ...base, providerClass: 'auth' }), null);
  assert.equal(getTerminalCapacityFailure({ ...base, providerClass: 'unavailable' }), null);
  assert.equal(getTerminalCapacityFailure({ ...base, providerClass: 'unknown' }), null);
});
