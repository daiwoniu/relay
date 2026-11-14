import type { EngineEventSource } from './events.js';
import type { EngineId } from './types.js';

export type EngineTurnFactType =
  | 'turn_started'
  | 'final_answer_completed'
  | 'engine_error'
  | 'interrupt_confirmed'
  | 'connection_closed'
  | 'recovery_in_progress'
  | 'recovery_completed'
  | 'recovery_failed'
  | 'recovery_interrupted';

export type EngineTurnFactPayload =
  | Record<string, never>
  | { hasContent: boolean; contentLength: number; contentDigest: string }
  | { errorCode?: string; retryable?: boolean;capacityFailure?:{retryAfterMs:number|null} }
  | { userInitiated: boolean };

export interface EngineTurnFact {
  id: string;
  sessionId: string;
  attemptId: string;
  engineId: EngineId;
  connectionId: string;
  externalSessionId?: string;
  externalTurnId?: string;
  factType: EngineTurnFactType;
  source: EngineEventSource;
  sequence: number;
  idempotencyKey: string;
  observedAt: number;
  payload: EngineTurnFactPayload;
}

export type EngineTerminalOutcome = 'completed' | 'failed' | 'interrupted' | 'stopped';

export interface EngineTerminalDecision {
  id: string;
  sessionId: string;
  attemptId: string;
  engineId: EngineId;
  externalTurnId?: string;
  outcome: EngineTerminalOutcome;
  reasonCode: string;
  factId: string;
  decidedAt: number;
  projectedAt: number | null;
}

export interface EngineTerminalFactContext {
  sessionId: string;
  attemptId: string;
  connectionId: string;
  engineId: EngineId;
  userStopRequested: boolean;
}
