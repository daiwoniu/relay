import {
  countActiveLeasesForUserInDatabase, countActiveLeasesInDatabase, countQueuedTurnsForUserInDatabase,
  getCapacityWindowsInDatabase, getConcurrencySettingInDatabase,
  getCooldownInDatabase, getQueueEntryBySessionInDatabase, listQueueEntriesInDatabase,
  upsertConcurrencySettingInDatabase,
} from '../db/engine-concurrency.js';
import type { SQLiteDB } from '../db/index.js';
import type { EngineRegistry } from '../engine/registry.js';
import {
  EngineConcurrencyDtoSchema, TurnQueueSnapshotDtoSchema,
  type EngineConcurrencyDto, type TurnQueueSnapshotDto,
} from '../contracts/index.js';

export function createEngineConcurrencyApi(input: {
  registry: EngineRegistry;
  getDb: () => SQLiteDB;
  broadcast: (resourceKey: string) => void;
  drain: (resourceKey: string) => Promise<void>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const resolve = (resourceKey: string) => {
    for (const adapter of input.registry.list()) {
      const resource = adapter.concurrency?.resolveResource({ sessionId: 'default', projectId: 'default' });
      if (resource?.resourceKey === resourceKey) return { adapter, resource };
    }
    return null;
  };
  const queue = (sessionId: string): TurnQueueSnapshotDto | null => {
    const db = input.getDb();
    const entry = getQueueEntryBySessionInDatabase(db, sessionId);
    if (!entry) return null;
    const registered = resolve(entry.resourceKey);
    if (!registered) return null;
    const waiting = listQueueEntriesInDatabase(db, entry.resourceKey)
      .filter((item) => item.state === 'queued' && item.requestedByUserId === entry.requestedByUserId);
    const position = waiting.findIndex((item) => item.id === entry.id);
    return TurnQueueSnapshotDtoSchema.parse({
      queueId: entry.id, sessionId: entry.sessionId, engineId: entry.engineId,
      resourceKey: entry.resourceKey, label: registered.resource.label, state: entry.state,
      position: entry.state === 'queued' && position >= 0 ? position + 1 : null,
      activeTurns: countActiveLeasesForUserInDatabase(db, entry.resourceKey, entry.requestedByUserId),
      maxActiveTurns: getConcurrencySettingInDatabase(db, entry.resourceKey)?.maxActiveTurns ?? registered.resource.defaultMaxActiveTurns,
      cooldownUntil: getCooldownInDatabase(db, entry.resourceKey)?.cooldownUntil ?? null,
      createdAt: entry.createdAt,
    });
  };
  const snapshot = (resourceKey: string, actor?: { id: string; role: 'admin' | 'member' }): EngineConcurrencyDto => {
    const db = input.getDb();
    const registered = resolve(resourceKey);
    if (!registered) throw new Error('未知引擎并发资源');
    const cooldown = getCooldownInDatabase(db, resourceKey);
    return EngineConcurrencyDtoSchema.parse({
      resourceKey, engineId: registered.adapter.id, label: registered.resource.label,
      maxActiveTurns: getConcurrencySettingInDatabase(db, resourceKey)?.maxActiveTurns ?? registered.resource.defaultMaxActiveTurns,
      activeTurns: actor?.role === 'member'
        ? countActiveLeasesForUserInDatabase(db, resourceKey, actor.id)
        : countActiveLeasesInDatabase(db, resourceKey),
      queuedTurns: actor?.role === 'member'
        ? countQueuedTurnsForUserInDatabase(db, resourceKey, actor.id)
        : listQueueEntriesInDatabase(db, resourceKey).filter((item) => item.state === 'queued').length,
      cooldownUntil: cooldown?.cooldownUntil ?? null, probeInProgress: Boolean(cooldown?.probeAttemptId),
      windows: getCapacityWindowsInDatabase(db, resourceKey, now(), [5, 15, 60]),
    });
  };
  return {
    getQueueSnapshot: queue,
    getSnapshot: snapshot,
    listSnapshots: (actor: { id: string; role: 'admin' | 'member' }) => input.registry.list().flatMap((adapter) => {
      const resource = adapter.concurrency?.resolveResource({ sessionId: 'default', projectId: 'default' });
      return resource ? [snapshot(resource.resourceKey, actor)] : [];
    }),
    update(resourceKey: string, maxActiveTurns: number, userId: string) {
      const registered = resolve(resourceKey);
      if (!registered) throw new Error('未知引擎并发资源');
      const db = input.getDb();
      upsertConcurrencySettingInDatabase(db, { resourceKey, engineId: registered.adapter.id, maxActiveTurns, updatedByUserId: userId, updatedAt: now() });
      db.saveToFile();
      const result = snapshot(resourceKey);
      input.broadcast(resourceKey);
      void input.drain(resourceKey);
      return result;
    },
  };
}
