import { buildEngineTurnFact,buildLocalEngineTurnFact } from './turn-fact-builder.js';
export { buildEngineTurnFact,buildLocalEngineTurnFact } from './turn-fact-builder.js';
import { randomUUID } from 'node:crypto';
import { appendEngineTurnFactInDatabase } from '../db/engine-turn-facts.js';
import { getDB } from '../db/index.js';
import { sanitizeTechnicalSummary } from './diagnostics.js';
import type { EngineEventEnvelope, EngineEventSource } from './events.js';
import type { EngineTerminalFactContext, EngineTurnFact, EngineTurnFactPayload, EngineTurnFactType } from './turn-facts.js';

export interface EngineTurnFactSink {
  record(event: EngineEventEnvelope, context: EngineTerminalFactContext): EngineTurnFact | null;
  recordInterruptConfirmed(context: EngineTerminalFactContext, observedAt?: number): EngineTurnFact | null;
  recordConnectionClosed(context: EngineTerminalFactContext, errorCode: string, observedAt?: number): EngineTurnFact | null;
  recordEngineError(context: EngineTerminalFactContext, errorCode: string | undefined, retryable?: boolean, observedAt?: number): EngineTurnFact | null;
  recordRecoveryFailed(context: EngineTerminalFactContext, errorCode: string, observedAt?: number): EngineTurnFact | null;
  recordRecoveryInterrupted(context: EngineTerminalFactContext, errorCode: string, observedAt?: number): EngineTurnFact | null;
}

export function createEngineTurnFactSink(options: {
  append?: (fact: EngineTurnFact) => EngineTurnFact;
  createId?: () => string;
  now?: () => number;
  diagnostic?: (message: string) => void;
} = {}): EngineTurnFactSink {
  const append = options.append ?? ((fact) => {
    const db = getDB();
    const stored = appendEngineTurnFactInDatabase(db, fact).fact;
    db.saveToFile();
    return stored;
  });
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? Date.now;
  const diagnostic = options.diagnostic ?? ((message) => console.warn(`[Relay] ${message}`));

  const persist = (input: {
    event?: EngineEventEnvelope;
    context: EngineTerminalFactContext;
    source: EngineEventSource;
    sequence: number;
    observedAt: number;
    factType: EngineTurnFactType;
    payload: EngineTurnFactPayload;
    externalSessionId?: string;
    externalTurnId?: string;
  }): EngineTurnFact | null => {
    const fact=buildLocalEngineTurnFact(input,createId);
    try {
      return append(fact);
    } catch (error) {
      const summary = sanitizeTechnicalSummary(error) || 'unknown';
      diagnostic(`TURN_FACT_SHADOW_WRITE_FAILED engine=${fact.engineId} fact=${fact.factType} summary=${summary}`);
      return null;
    }
  };

  return {
    record(event, context) {
      const fact = buildEngineTurnFact(event, context, createId);
      if (!fact) return null;
      try { return append(fact); }
      catch (error) {
        diagnostic(`TURN_FACT_SHADOW_WRITE_FAILED engine=${fact.engineId} fact=${fact.factType} summary=${sanitizeTechnicalSummary(error) || 'unknown'}`);
        return null;
      }
    },
    recordInterruptConfirmed(context, observedAt = now()) {
      return persist({ context, source: 'local', sequence: 0, observedAt,
        factType: 'interrupt_confirmed', payload: { userInitiated: context.userStopRequested } });
    },
    recordConnectionClosed(context, errorCode, observedAt = now()) {
      return persist({ context, source: 'process_exit', sequence: 0, observedAt,
        factType: 'connection_closed', payload: { errorCode } });
    },
    recordEngineError(context, errorCode, retryable = false, observedAt = now()) {
      return persist({ context, source: 'local', sequence: 0, observedAt,
        factType: 'engine_error', payload: { errorCode, retryable } });
    },
    recordRecoveryFailed(context, errorCode, observedAt = now()) {
      return persist({ context, source: 'recovery', sequence: 0, observedAt,
        factType: 'recovery_failed', payload: { errorCode } });
    },
    recordRecoveryInterrupted(context, errorCode, observedAt = now()) {
      return persist({ context, source: 'recovery', sequence: 0, observedAt,
        factType: 'recovery_interrupted', payload: { errorCode } });
    },
  };
}
