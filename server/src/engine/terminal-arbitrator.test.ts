import assert from 'node:assert/strict';
import test from 'node:test';
import { arbitrateTerminalDecision } from './terminal-arbitrator.js';
import type { EngineTurnFact, EngineTerminalDecision } from './turn-facts.js';

const fact = (
  factType: EngineTurnFact['factType'],
  payload: EngineTurnFact['payload'],
  observedAt = 1,
): EngineTurnFact => ({
  id: `fact-${factType}-${observedAt}`,
  sessionId: 'session-1',
  attemptId: 'attempt-1',
  engineId: 'codex',
  connectionId: 'connection-1',
  factType,
  source: 'realtime',
  sequence: observedAt,
  idempotencyKey: `key-${factType}-${observedAt}`,
  observedAt,
  payload,
});

test('非空最终正文形成 completed，空正文形成 failed', () => {
  assert.deepEqual(arbitrateTerminalDecision(null, [fact('final_answer_completed', {
    hasContent: true, contentLength: 5, contentDigest: 'digest',
  })]), {
    kind: 'decide', outcome: 'completed', reasonCode: 'FINAL_ANSWER_COMPLETED', factId: 'fact-final_answer_completed-1',
  });
  assert.deepEqual(arbitrateTerminalDecision(null, [fact('final_answer_completed', {
    hasContent: false, contentLength: 0, contentDigest: 'empty',
  })]), {
    kind: 'decide', outcome: 'failed', reasonCode: 'FINAL_ANSWER_MISSING', factId: 'fact-final_answer_completed-1',
  });
});

test('用户停止与非用户中断具有不同公开终态', () => {
  assert.equal(arbitrateTerminalDecision(null, [fact('interrupt_confirmed', { userInitiated: true })]).outcome, 'stopped');
  assert.equal(arbitrateTerminalDecision(null, [fact('interrupt_confirmed', { userInitiated: false })]).outcome, 'interrupted');
  assert.equal(arbitrateTerminalDecision(null, [fact('recovery_interrupted', { errorCode: 'CODEBUDDY_RESTART_INTERRUPTED' })]).outcome, 'interrupted');
});

test('用户确认停止覆盖同一取消链上的中断错误且不受毫秒时序影响', () => {
  const interrupted = fact('engine_error', { errorCode: 'CODEX_TURN_INTERRUPTED', retryable: false }, 1);
  const confirmed = fact('interrupt_confirmed', { userInitiated: true }, 2);
  assert.equal(arbitrateTerminalDecision(null, [interrupted, confirmed]).outcome, 'stopped');
  assert.equal(arbitrateTerminalDecision(null, [
    { ...interrupted, observedAt: 1, sequence: 2 },
    { ...confirmed, observedAt: 1, sequence: 0 },
  ]).outcome, 'stopped');
  assert.equal(arbitrateTerminalDecision(null, [
    fact('engine_error', { errorCode: 'PROVIDER_FAILED', retryable: false }, 1),
    confirmed,
  ]).outcome, 'failed');
});

test('引擎错误、连接关闭和恢复失败形成 failed', () => {
  assert.equal(arbitrateTerminalDecision(null, [fact('engine_error', { errorCode: 'PROVIDER_FAILED', retryable: false })]).outcome, 'failed');
  assert.equal(arbitrateTerminalDecision(null, [fact('connection_closed', { errorCode: 'CONNECTION_CLOSED' })]).outcome, 'failed');
  assert.equal(arbitrateTerminalDecision(null, [fact('recovery_failed', { errorCode: 'RECOVERY_FAILED' })]).outcome, 'failed');
});

test('引擎错误缺少错误码时不编造 reasonCode', () => {
  assert.equal(arbitrateTerminalDecision(null, [fact('engine_error', { retryable: false })]).reasonCode, '');
  assert.equal(arbitrateTerminalDecision(null, [fact('engine_error', {})]).reasonCode, '');
});

test('非终态事实不产生决定，重复事实只处理一次', () => {
  const started = fact('turn_started', {});
  assert.deepEqual(arbitrateTerminalDecision(null, [started]), { kind: 'none' });
  const completed = fact('final_answer_completed', { hasContent: true, contentLength: 2, contentDigest: 'ok' }, 2);
  assert.equal(arbitrateTerminalDecision(null, [started, completed, completed]).outcome, 'completed');
});

test('已有终态不可被迟到事实覆盖', () => {
  const existing: EngineTerminalDecision = {
    id: 'decision-1', sessionId: 'session-1', attemptId: 'attempt-1', engineId: 'codex',
    outcome: 'completed', reasonCode: 'FINAL_ANSWER_COMPLETED', factId: 'fact-complete', decidedAt: 1, projectedAt: 1,
  };
  assert.deepEqual(arbitrateTerminalDecision(existing, [fact('engine_error', { errorCode: 'LATE_ERROR', retryable: false }, 2)]), {
    kind: 'conflict', existing, candidate: { outcome: 'failed', reasonCode: 'LATE_ERROR', factId: 'fact-engine_error-2' },
  });
  assert.deepEqual(arbitrateTerminalDecision(existing, [fact('final_answer_completed', {
    hasContent: true, contentLength: 2, contentDigest: 'same',
  })]), { kind: 'unchanged', decision: existing });
});

test('completed recovery snapshot 仍要求非空最终正文', () => {
  assert.equal(arbitrateTerminalDecision(null, [fact('recovery_completed', {
    hasContent: true, contentLength: 8, contentDigest: 'recovered',
  })]).outcome, 'completed');
  assert.equal(arbitrateTerminalDecision(null, [fact('recovery_completed', {
    hasContent: false, contentLength: 0, contentDigest: 'empty',
  })]).reasonCode, 'FINAL_ANSWER_MISSING');
});
