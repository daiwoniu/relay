import type { EngineId } from './types.js';

export const ENGINE_PERFORMANCE_LOG_PREFIX = '[Relay:EnginePerformance] ';

export type EnginePerformanceMilestone =
  | 'dispatch_claimed'
  | 'connection_started'
  | 'transport_opened'
  | 'protocol_initialized'
  | 'configuration_ready'
  | 'external_session_ready'
  | 'provider_request_sent'
  | 'provider_turn_started'
  | 'first_engine_output'
  | 'terminal_received';

export type EnginePerformanceOutcome = 'completed' | 'failed' | 'interrupted' | 'closed';

export interface EnginePerformanceObserver {
  mark(milestone: EnginePerformanceMilestone, observedAt?: number): void;
  finish(outcome: EnginePerformanceOutcome, observedAt?: number): void;
  close(): void;
}

interface EnginePerformanceRecord {
  engine: EngineId;
  existingSession: boolean;
  connectionReused: boolean;
  recovery: boolean;
  outcome: EnginePerformanceOutcome;
  connectionMs?: number;
  initializeMs?: number;
  configurationMs?: number;
  sessionReadyMs?: number;
  requestSendMs?: number;
  turnStartMs?: number;
  firstOutputMs?: number;
  terminalMs?: number;
  totalMs?: number;
}

const duration = (timestamps: Map<EnginePerformanceMilestone, number>, from: EnginePerformanceMilestone, to: EnginePerformanceMilestone) => {
  const startedAt = timestamps.get(from);
  const finishedAt = timestamps.get(to);
  return startedAt !== undefined && finishedAt !== undefined && finishedAt >= startedAt
    ? finishedAt - startedAt
    : undefined;
};

export function createEnginePerformanceObservation(input: {
  engine: EngineId;
  existingSession: boolean;
  connectionReused?: boolean;
  recovery?: boolean;
  startedAt?: number;
  write?: (line: string) => void;
}): EnginePerformanceObserver {
  const timestamps = new Map<EnginePerformanceMilestone, number>();
  timestamps.set('dispatch_claimed', input.startedAt ?? Date.now());
  const write = input.write ?? ((line: string) => {
    if (!process.env.NODE_TEST_CONTEXT) console.log(line);
  });
  let outcome: EnginePerformanceOutcome | null = null;
  let emitted = false;

  const mark = (milestone: EnginePerformanceMilestone, observedAt = Date.now()) => {
    if (!Number.isFinite(observedAt) || timestamps.has(milestone)) return;
    timestamps.set(milestone, observedAt);
  };
  const emit = () => {
    if (emitted || !outcome) return;
    emitted = true;
    const sessionBase = timestamps.has('configuration_ready') ? 'configuration_ready' : 'protocol_initialized';
    const record: EnginePerformanceRecord = {
      engine: input.engine,
      existingSession: input.existingSession,
      connectionReused: input.connectionReused ?? false,
      recovery: input.recovery ?? false,
      outcome,
      ...numberField('connectionMs', duration(timestamps, 'connection_started', 'transport_opened')),
      ...numberField('initializeMs', duration(timestamps, 'transport_opened', 'protocol_initialized')),
      ...numberField('configurationMs', duration(timestamps, 'protocol_initialized', 'configuration_ready')),
      ...numberField('sessionReadyMs', duration(timestamps, sessionBase, 'external_session_ready')),
      ...numberField('requestSendMs', duration(timestamps, 'external_session_ready', 'provider_request_sent')),
      ...numberField('turnStartMs', duration(timestamps, 'provider_request_sent', 'provider_turn_started')),
      ...numberField('firstOutputMs', duration(timestamps, 'provider_request_sent', 'first_engine_output')),
      ...numberField('terminalMs', duration(timestamps, 'provider_request_sent', 'terminal_received')),
      ...numberField('totalMs', duration(timestamps, 'dispatch_claimed', 'terminal_received')),
    };
    try {
      write(`${ENGINE_PERFORMANCE_LOG_PREFIX}${JSON.stringify(record)}`);
    } catch {
      // 性能观测不能影响引擎运行链路。
    }
  };

  return {
    mark,
    finish(nextOutcome, observedAt = Date.now()) {
      if (outcome) return;
      outcome = nextOutcome;
      mark('terminal_received', observedAt);
      emit();
    },
    close() {
      outcome ??= 'closed';
      emit();
    },
  };
}

function numberField<K extends string>(key: K, value: number | undefined): Record<K, number> | Record<string, never> {
  return value === undefined ? {} : { [key]: value } as Record<K, number>;
}
