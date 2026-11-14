import { createHash,randomUUID } from 'node:crypto';
import type { EngineEventEnvelope,EngineEventSource } from './events.js';
import type { EngineTerminalFactContext,EngineTurnFact,EngineTurnFactPayload,EngineTurnFactType } from './turn-facts.js';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function contentPayload(content: string): EngineTurnFactPayload {
  const normalized = content.trim();
  return { hasContent: Boolean(normalized), contentLength: normalized.length, contentDigest: digest(normalized) };
}

function eventFact(event: EngineEventEnvelope): { factType: EngineTurnFactType; payload: EngineTurnFactPayload } | null {
  const payload = event.payload;
  switch (payload.type) {
    case 'turn_start': return { factType: 'turn_started', payload: {} };
    case 'message_complete': return { factType: 'final_answer_completed', payload: contentPayload(payload.content) };
    case 'error': return { factType: 'engine_error', payload: { errorCode: payload.diagnostic.code, retryable: payload.diagnostic.retryable,
      ...(['rate_limit','overloaded'].includes(payload.diagnostic.providerClass??'')?{capacityFailure:{retryAfterMs:payload.diagnostic.retryAfterMs??null}}:{}) } };
    case 'recovery_snapshot': {
      if (payload.status === 'inProgress') return { factType: 'recovery_in_progress', payload: {} };
      if (payload.status === 'completed') return { factType: 'recovery_completed', payload: contentPayload(payload.content) };
      if (payload.status === 'interrupted') return { factType: 'recovery_interrupted', payload: { errorCode: payload.error?.code || 'RECOVERY_INTERRUPTED' } };
      return { factType: 'recovery_failed', payload: { errorCode: payload.error?.code || 'RECOVERY_FAILED' } };
    }
    default: return null;
  }
}

function stableKey(input: {
  event?: EngineEventEnvelope;
  context: EngineTerminalFactContext;
  factType: EngineTurnFactType;
  payload: EngineTurnFactPayload;
}): string {
  const { event, context, factType, payload } = input;
  if (event?.meta.eventId) return `${event.engineId}:event:${event.meta.eventId}`;
  const externalTurnId = event?.meta.externalTurnId
    || ('turnId' in (event?.payload || {}) && typeof (event?.payload as any).turnId === 'string' ? (event?.payload as any).turnId : undefined);
  const payloadDigest = digest(JSON.stringify(payload));
  if (event?.meta.externalSessionId && externalTurnId) {
    return `${event.engineId}:external:${event.meta.externalSessionId}:${externalTurnId}:${factType}:${payloadDigest}`;
  }
  return `${context.engineId}:attempt:${context.sessionId}:${context.attemptId}:${factType}:${payloadDigest}`;
}

/** Pure event conversion shared by legacy shadow writes and the awaited storage path. */
export function buildEngineTurnFact(event: EngineEventEnvelope, context: EngineTerminalFactContext,
  createId: () => string = randomUUID): EngineTurnFact | null {
  const candidate = eventFact(event);
  if (!candidate) return null;
  const payload = Object.fromEntries(Object.entries(candidate.payload).filter(([, value]) => value !== undefined)) as EngineTurnFactPayload;
  const externalTurnId = event.meta.externalTurnId
    || ('turnId' in event.payload && typeof event.payload.turnId === 'string' ? event.payload.turnId : undefined);
  return { id: createId(), sessionId: context.sessionId, attemptId: context.attemptId, engineId: context.engineId,
    connectionId: context.connectionId, factType: candidate.factType, payload, source: event.meta.source,
    sequence: event.meta.sequence, observedAt: event.meta.observedAt,
    idempotencyKey: stableKey({ event, context, factType: candidate.factType, payload }),
    ...(event.meta.externalSessionId ? { externalSessionId: event.meta.externalSessionId } : {}),
    ...(externalTurnId ? { externalTurnId } : {}) };
}

/** Local lifecycle evidence shares the same idempotency rules as engine events. */
export function buildLocalEngineTurnFact(input: {
  context: EngineTerminalFactContext; factType: EngineTurnFactType; payload: EngineTurnFactPayload;
  source: EngineEventSource; observedAt: number;
}, createId: () => string = randomUUID): EngineTurnFact {
  const payload = Object.fromEntries(Object.entries(input.payload).filter(([, value]) => value !== undefined)) as EngineTurnFactPayload;
  return { id: createId(), sessionId: input.context.sessionId, attemptId: input.context.attemptId,
    engineId: input.context.engineId, connectionId: input.context.connectionId,
    factType: input.factType, payload, source: input.source, sequence: 0, observedAt: input.observedAt,
    idempotencyKey: stableKey({ context: input.context, factType: input.factType, payload }) };
}

