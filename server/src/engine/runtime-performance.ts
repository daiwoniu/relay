import type { EngineEvent } from './adapter.js';
import { createEnginePerformanceObservation, type EnginePerformanceMilestone, type EnginePerformanceOutcome } from './performance-observability.js';
import type { SessionRuntime } from './runtime.js';
import type { EngineId } from './types.js';

export function beginTurnPerformanceObservation(runtime: SessionRuntime, input: {
  engine: EngineId;
  existingSession: boolean;
  connectionReused: boolean;
  recovery?: boolean;
  startedAt: number;
}): void {
  runtime.performanceObservation = createEnginePerformanceObservation(input);
  if (input.connectionReused) runtime.performanceObservation.mark('external_session_ready', input.startedAt);
}

export function ensureConnectionPerformanceObservation(runtime: SessionRuntime, engine: EngineId, existingSession: boolean): void {
  const observedAt = Date.now();
  runtime.performanceObservation ??= createEnginePerformanceObservation({
    engine, existingSession, connectionReused: false,
    recovery: runtime.isRecovering,
    startedAt: resolvePerformanceStartedAt(runtime, observedAt),
  });
  runtime.performanceObservation.mark('connection_started', observedAt);
}

export function resolvePerformanceStartedAt(runtime: Pick<SessionRuntime, 'isRecovering' | 'turnStartTime'>, observedAt: number): number {
  return runtime.isRecovering ? observedAt : runtime.turnStartTime ?? observedAt;
}

export function markPerformanceMilestone(runtime: SessionRuntime, milestone: EnginePerformanceMilestone): void {
  runtime.performanceObservation?.mark(milestone);
}

export function observeSessionReady(runtime: SessionRuntime, callback: (id: string) => unknown): (id: string) => unknown {
  return (id) => { markPerformanceMilestone(runtime, 'external_session_ready'); return callback(id); };
}

export function observeEnginePerformanceEvent(runtime: SessionRuntime, event: EngineEvent): void {
  if (runtime.engine === 'codex' && event.type === 'turn_start') markPerformanceMilestone(runtime, 'provider_turn_started');
  if (event.type === 'delta' || event.type === 'item_start' || event.type === 'item_complete'
    || event.type === 'server_request' || event.type === 'message_complete' || event.type === 'error') {
    markPerformanceMilestone(runtime, 'first_engine_output');
  }
}

export function finishPerformanceObservation(runtime: SessionRuntime, outcome: EnginePerformanceOutcome): void {
  runtime.performanceObservation?.finish(outcome);
}

export function closePerformanceObservation(runtime: SessionRuntime): void {
  runtime.performanceObservation?.close();
  runtime.performanceObservation = null;
}
