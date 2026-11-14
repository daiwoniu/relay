import type { EngineConcurrencyDto } from '../generated/relay-contracts';
import { jsonBody, requestJson } from './client';

export const getEngineConcurrency = (signal?: AbortSignal) => requestJson<EngineConcurrencyDto[]>('/api/engine-concurrency', { signal });

export const updateEngineConcurrency = (resourceKey: string, maxActiveTurns: number, signal?: AbortSignal) => (
  requestJson<EngineConcurrencyDto>(`/api/engine-concurrency/${encodeURIComponent(resourceKey)}`, {
    method: 'PATCH',
    signal,
    ...jsonBody({ maxActiveTurns }),
  })
);

export const cancelQueuedTurn = (sessionId: string, signal?: AbortSignal) => requestJson<{ ok: true }>(
  `/api/sessions/${encodeURIComponent(sessionId)}/queued-turn/cancel`,
  { method: 'POST', signal },
);
