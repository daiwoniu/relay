import type { EngineProviderCooldown } from '../../db/engine-concurrency.js';

const OVERLOAD_BACKOFF_MS = [30_000, 60_000, 120_000] as const;
const MAX_RETRY_AFTER_MS = 3_600_000;

export type CooldownInspection =
  | { state: 'open' }
  | { state: 'blocked'; retryAfterMs: number }
  | { state: 'probe_required' }
  | { state: 'probe_in_progress' };

export function inspectCooldown(cooldown: EngineProviderCooldown | null, now: number): CooldownInspection {
  if (!cooldown || cooldown.consecutiveOverloads === 0) return { state: 'open' };
  if (cooldown.probeAttemptId) return { state: 'probe_in_progress' };
  if (cooldown.cooldownUntil != null && cooldown.cooldownUntil > now) {
    return { state: 'blocked', retryAfterMs: cooldown.cooldownUntil - now };
  }
  return { state: 'probe_required' };
}

export function computeOverloadCooldown(
  resourceKey: string,
  previous: EngineProviderCooldown | null,
  now: number,
  retryAfterMs: number | null,
): EngineProviderCooldown {
  const consecutiveOverloads = (previous?.consecutiveOverloads ?? 0) + 1;
  const backoff = OVERLOAD_BACKOFF_MS[Math.min(consecutiveOverloads - 1, OVERLOAD_BACKOFF_MS.length - 1)];
  const providerDelay = retryAfterMs == null
    ? 0
    : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.trunc(retryAfterMs)));
  return {
    resourceKey,
    consecutiveOverloads,
    cooldownUntil: now + Math.max(backoff, providerDelay),
    probeAttemptId: null,
    lastOverloadAt: now,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    updatedAt: now,
  };
}

export function acceptCooldownProbe(
  cooldown: EngineProviderCooldown,
  attemptId: string,
  now: number,
): EngineProviderCooldown {
  if (cooldown.probeAttemptId !== attemptId) return cooldown;
  return {
    ...cooldown,
    consecutiveOverloads: 0,
    cooldownUntil: null,
    probeAttemptId: null,
    lastSuccessAt: now,
    updatedAt: now,
  };
}
