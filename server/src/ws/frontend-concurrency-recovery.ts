import {
  getCooldownInDatabase,
  markLeaseRunningInDatabase,
} from '../db/engine-concurrency.js';
import type { SQLiteDB } from '../db/index.js';
import type { SessionRuntime } from '../engine/runtime.js';

export function reconcileRecoveredConcurrency(
  db: SQLiteDB,
  runtime: SessionRuntime,
  acceptProbe: (resourceKey: string, attemptId: string) => Promise<void>,
  now = Date.now(),
): void {
  if (!runtime.attemptId) return;
  const started = markLeaseRunningInDatabase(db, runtime.attemptId, now);
  if (started) db.saveToFile();
  if (!runtime.resourceKey
    || getCooldownInDatabase(db, runtime.resourceKey)?.probeAttemptId !== runtime.attemptId) return;
  void acceptProbe(runtime.resourceKey, runtime.attemptId).catch(() => undefined);
}
