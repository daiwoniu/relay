import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSessionTerminalLog } from './session-observability.js';

test('会话失败日志只保留终态诊断字段并限制错误文本', () => {
  const line = formatSessionTerminalLog({
    sessionId: 'session-1', engine: 'codex', outcome: 'failed',
    code: 'CODEX_SERVER_OVERLOADED', phase: 'send', providerClass: 'overloaded',
    retryable: true, model: 'gpt-test', durationMs: 1200,
    message: `Selected model is at capacity ${'x'.repeat(20_000)}`,
  });
  assert.match(line, /^\[Relay:SessionTerminal\] /);
  const payload = JSON.parse(line.slice('[Relay:SessionTerminal] '.length));
  assert.deepEqual(payload, {
    sessionId: 'session-1', engine: 'codex', model: 'gpt-test', outcome: 'failed',
    code: 'CODEX_SERVER_OVERLOADED', phase: 'send', providerClass: 'overloaded',
    retryable: true, durationMs: 1200,
    message: `Selected model is at capacity ${'x'.repeat(500 - 'Selected model is at capacity '.length)}`,
  });
});
