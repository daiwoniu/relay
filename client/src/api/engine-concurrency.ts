import type { EngineConcurrencyDto } from '../generated/relay-contracts';
import { jsonBody, requestJson } from './client';

export const getEngineConcurrency = (signal?: AbortSignal) => requestJson<EngineConcurrencyDto[]>('/api/engine-concurrency', { signal });

export const updateEngineConcurrency = (resourceKey: string, maxActiveTurns: number, signal?: AbortSignal) => (
  requestJson<EngineConcurrencyDto>(`/api/engine-concurrency/${encodeURIComponent(resourceKey)}`, {
    analytics:{feature:'settings',action:'save',surface:'settings',settingKey:'concurrency'},
    method: 'PATCH',
    signal,
    ...jsonBody({ maxActiveTurns }),
  })
);

export const cancelQueuedTurn = (sessionId: string, signal?: AbortSignal) => requestJson<{ ok: true }>(
  `/api/sessions/${encodeURIComponent(sessionId)}/queued-turn/cancel`,
  { analytics:{feature:'composer',action:'cancel_queued',surface:'button'},method: 'POST', signal },
);
