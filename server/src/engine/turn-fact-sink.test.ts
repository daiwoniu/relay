import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineEventEnvelope } from './events.js';
import { createEngineTurnFactSink } from './turn-fact-sink.js';
import type { EngineTurnFact } from './turn-facts.js';

const context = {
  sessionId: 'session-1', attemptId: 'attempt-1', connectionId: 'connection-1', engineId: 'codex' as const, userStopRequested: false,
};

function envelope(payload: EngineEventEnvelope['payload'], sequence = 1): EngineEventEnvelope {
  return { engineId: 'codex', meta: { observedAt: 100 + sequence, source: 'realtime', sequence }, payload };
}

test('sink 只记录低频终态候选并且不保存正文', () => {
  const facts: EngineTurnFact[] = [];
  const sink = createEngineTurnFactSink({ append: (fact) => { facts.push(fact); return fact; }, createId: () => `fact-${facts.length + 1}` });
  assert.equal(sink.record(envelope({ type: 'delta', itemId: 'item-1', content: '秘密正文', phase: 'final_answer' }), context), null);
  const fact = sink.record(envelope({ type: 'message_complete', turnId: 'turn-1', content: '最终正文' }, 2), context);
  assert.equal(fact?.factType, 'final_answer_completed');
  assert.equal(JSON.stringify(fact?.payload).includes('最终正文'), false);
  assert.deepEqual(Object.keys(fact?.payload || {}).sort(), ['contentDigest', 'contentLength', 'hasContent']);
});

test('sink 标准化错误、恢复和合成中断事实', () => {
  const facts: EngineTurnFact[] = [];
  const sink = createEngineTurnFactSink({ append: (fact) => { facts.push(fact); return fact; }, createId: () => `fact-${facts.length + 1}` });
  sink.record(envelope({ type: 'error', diagnostic: {
    code: 'PROVIDER_FAILED', phase: 'provider', retryable: true, userMessage: '失败', technicalSummary: 'token=secret',
  } }), context);
  sink.record(envelope({ type: 'recovery_snapshot', turnId: 'turn-1', status: 'completed', content: '恢复正文', items: [], waitingOnInteraction: false }, 2), context);
  sink.recordInterruptConfirmed({ ...context, userStopRequested: true }, 103);
  sink.recordConnectionClosed(context, 'CODEX_CONNECTION_CLOSED', 104);
  sink.recordEngineError(context, 'TASK_START_FAILED', false, 105);
  sink.recordRecoveryFailed(context, 'RESTART_RECOVERY_FAILED', 106);
  sink.recordRecoveryInterrupted(context, 'CODEBUDDY_RESTART_INTERRUPTED', 107);
  assert.deepEqual(facts.map((fact) => fact.factType), [
    'engine_error', 'recovery_completed', 'interrupt_confirmed', 'connection_closed',
    'engine_error', 'recovery_failed', 'recovery_interrupted',
  ]);
  assert.equal(JSON.stringify(facts).includes('secret'), false);
});

test('sink 写入失败只报告安全诊断并允许调用方继续', () => {
  const diagnostics: string[] = [];
  const sink = createEngineTurnFactSink({
    append: () => { throw new Error('database failed token=secret'); },
    diagnostic: (message) => diagnostics.push(message),
  });
  assert.doesNotThrow(() => sink.record(envelope({ type: 'turn_start', turnId: 'turn-1' }), context));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.includes('secret'), false);
  assert.match(diagnostics[0] || '', /TURN_FACT_SHADOW_WRITE_FAILED/);
});
