import type { EngineEvent } from './adapter.js';
import type { EngineId } from './types.js';

export type EngineEventSource =
  | 'local'
  | 'realtime'
  | 'request_response'
  | 'history'
  | 'recovery'
  | 'process_exit';

export interface EngineEventMeta {
  observedAt: number;
  source: EngineEventSource;
  sequence: number;
  eventId?: string;
  externalSessionId?: string;
  externalTurnId?: string;
}

export interface EngineEventEnvelope {
  engineId: EngineId;
  meta: EngineEventMeta;
  payload: EngineEvent;
}

export function createEngineEventEmitter(input: {
  engineId: EngineId;
  emit(envelope: EngineEventEnvelope): void;
  now?: () => number;
}) {
  let sequence = 0;
  const now = input.now ?? Date.now;
  return (payload: EngineEvent, meta: Omit<EngineEventMeta, 'observedAt' | 'sequence'> & {
    observedAt?: number;
  }): void => {
    input.emit({
      engineId: input.engineId,
      meta: {
        observedAt: meta.observedAt ?? now(),
        source: meta.source,
        sequence: ++sequence,
        ...(meta.eventId ? { eventId: meta.eventId } : {}),
        ...(meta.externalSessionId ? { externalSessionId: meta.externalSessionId } : {}),
        ...(meta.externalTurnId ? { externalTurnId: meta.externalTurnId } : {}),
      },
      payload,
    });
  };
}
