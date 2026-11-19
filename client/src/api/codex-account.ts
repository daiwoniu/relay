import type { CodexAccountSnapshotDto, CodexResetCreditResultDto } from '../generated/relay-contracts';
import { jsonBody, requestJson } from './client';

export const getCodexAccount = (signal?: AbortSignal, force = false) => requestJson<CodexAccountSnapshotDto>(`/api/system/codex-account${force ? '?refresh=1' : ''}`, { signal, timeoutMs: 45_000 });

export interface CodexResourceSnapshot {
  account: CodexAccountSnapshotDto;
  localUsage: CodexLocalUsageSnapshot | null;
  localUsageError: string | null;
}
export const getCodexResourceSnapshot = (signal?: AbortSignal) => requestJson<CodexResourceSnapshot>(
  '/api/system/codex-account/resources', { signal, timeoutMs: 45_000 },
);

export interface CodexLocalUsageSnapshot {
  email: string;
  timeZone: 'Asia/Shanghai';
  dailyUsageBuckets: { startDate: string; tokens: number }[];
  backfill: { email: string; completedAt: number } | null;
  sourceMeta?: { state: 'live' | 'failed_snapshot' | 'unavailable'; lastSuccessAt: number | null;
    lastAttemptAt: number | null; error: string | null };
}

export const getCodexLocalUsage = (signal?: AbortSignal) => requestJson<CodexLocalUsageSnapshot>('/api/system/codex-account/local-usage', { signal, timeoutMs: 45_000 });

export const consumeCodexResetCredit = (idempotencyKey: string, creditId?: string) => requestJson<CodexResetCreditResultDto>(
  '/api/system/codex-account/reset-credit', { analytics:{feature:'workbench',action:'reset_quota',surface:'workbench'},method: 'POST', ...jsonBody({ idempotencyKey, ...(creditId ? { creditId } : {}) }) },
);
