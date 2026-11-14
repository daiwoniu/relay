import { shouldAutoRefreshSnapshot } from './workspace-persistent-snapshot.ts';

type SourceMeta = Parameters<typeof shouldAutoRefreshSnapshot>[0];
const failed = (meta: SourceMeta) => meta?.state === 'failed_snapshot' || meta?.state === 'unavailable';

// Distinguish our own resource response from an account change published by another view.
export function createWorkspaceIdentityRefreshTracker(initialIdentity: string | null = null) {
  let observed = initialIdentity;
  let received: string | null = null;
  let pending = false;
  return {
    observe(identity: string | null) {
      if (identity === observed) return;
      observed = identity;
      pending = identity !== received;
    },
    received(identity: string | null) {
      received = identity;
      if (identity === observed) pending = false;
    },
    take() {
      const next = pending;
      pending = false;
      return next;
    },
  };
}

export function createWorkspaceRefreshTracker(now: () => number = Date.now) {
  let failures = 0;
  let lastAttemptAt = 0;
  const pending = new Map<Promise<unknown>, Promise<unknown>>();
  return {
    track<T>(request: Promise<T>, isFailure?: (value: T) => boolean): Promise<T> {
      const existing = pending.get(request);
      if (existing) return existing as Promise<T>;
      const next = request.then((value) => {
        lastAttemptAt = now();
        const meta = (value as { sourceMeta?: SourceMeta } | null)?.sourceMeta;
        failures = failed(meta) || isFailure?.(value) ? failures + 1 : 0;
        return value;
      }, (error) => {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          lastAttemptAt = now();
          failures++;
        }
        throw error;
      }).finally(() => { pending.delete(request); });
      pending.set(request, next);
      return next;
    },
    reason(meta: SourceMeta, ttlMs: number): 'auto' | 'retry' | null {
      if (pending.size) return null;
      if (failures || failed(meta)) {
        const cooldown = Math.min(60 * 60_000, 5 * 60_000 * 2 ** Math.min(4, Math.max(0, failures - 1)));
        return now() >= Math.max(lastAttemptAt, meta?.lastAttemptAt ?? 0) + cooldown ? 'retry' : null;
      }
      if (!meta && lastAttemptAt > 0 && now() - lastAttemptAt >= ttlMs) return 'auto';
      return shouldAutoRefreshSnapshot(meta, now(), ttlMs, true) ? 'auto' : null;
    },
  };
}
