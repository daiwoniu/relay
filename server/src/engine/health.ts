import type { EngineId } from './types.js';

export interface EngineLocalHealth {
  engineId: EngineId;
  observedAt: number;
  installation: 'missing' | 'installed' | 'unknown';
  authentication: 'ready' | 'required' | 'unknown';
  protocol: 'ready' | 'incompatible' | 'unchecked' | 'unknown';
  process: 'ready' | 'stopped' | 'on_demand' | 'failed' | 'unknown';
  readiness: 'ready' | 'stale' | 'failed' | 'unchecked';
  available: boolean;
  code: string;
  message: string;
}

export function createUncheckedEngineHealth(input: {
  engineId: EngineId;
  available: boolean;
  code: string;
  message: string;
  process?: EngineLocalHealth['process'];
}): EngineLocalHealth {
  return {
    engineId: input.engineId,
    observedAt: Date.now(),
    installation: 'unknown',
    authentication: 'unknown',
    protocol: 'unchecked',
    process: input.process ?? 'unknown',
    readiness: 'unchecked',
    available: input.available,
    code: input.code,
    message: input.message,
  };
}
