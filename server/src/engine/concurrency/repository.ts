import { randomUUID } from 'node:crypto';
import type {
  EngineCapacityEventType,
  EngineProviderCooldown,
  EngineQueueEntry,
  EngineResourceLease,
} from '../../db/engine-concurrency.js';
import {
  appendCapacityEventInDatabase,
  claimNextQueuedEntryInDatabase,
  getConcurrencySettingInDatabase,
  getCooldownInDatabase,
  pruneCapacityEventsInDatabase,
  upsertCooldownInDatabase,
} from '../../db/engine-concurrency.js';
import type { SQLiteDB } from '../../db/index.js';

export interface QueueClaim {
  queue: EngineQueueEntry;
  lease: EngineResourceLease;
}

export interface EngineConcurrencyRepository {
  getMaxActiveTurns(resourceKey: string): Promise<number> | number;
  getCooldown(resourceKey: string): Promise<EngineProviderCooldown | null> | EngineProviderCooldown | null;
  claimNext(input: {
    resourceKey: string;
    maxActiveTurns: number;
    claimToken: string;
    now: number;
  }): Promise<QueueClaim | null> | QueueClaim | null;
  setProbe(resourceKey: string, attemptId: string, now: number): Promise<void> | void;
  saveCooldown(cooldown: EngineProviderCooldown): Promise<void> | void;
  appendCapacityEvent(input: {
    resourceKey: string;
    attemptId: string | null;
    eventType: EngineCapacityEventType;
    occurredAt: number;
  }): Promise<void> | void;
}

export interface QueueClaimDispatcher {
  start(claim: QueueClaim): Promise<void> | void;
  fail(claim: QueueClaim, error: unknown): Promise<void> | void;
}

export class DatabaseEngineConcurrencyRepository implements EngineConcurrencyRepository {
  private lastPrunedAt: number | null = null;

  constructor(
    private readonly db: SQLiteDB,
    private readonly defaultLimit: (resourceKey: string) => number,
    private readonly idFactory: () => string = randomUUID,
  ) {}

  getMaxActiveTurns(resourceKey: string): number {
    return getConcurrencySettingInDatabase(this.db, resourceKey)?.maxActiveTurns
      ?? this.defaultLimit(resourceKey);
  }

  getCooldown(resourceKey: string): EngineProviderCooldown | null {
    return getCooldownInDatabase(this.db, resourceKey);
  }

  claimNext(input: {
    resourceKey: string;
    maxActiveTurns: number;
    claimToken: string;
    now: number;
  }): QueueClaim | null {
    const claim = claimNextQueuedEntryInDatabase(this.db, input);
    if (claim) this.db.saveToFile();
    return claim;
  }

  setProbe(resourceKey: string, attemptId: string, now: number): void {
    const cooldown = getCooldownInDatabase(this.db, resourceKey);
    if (!cooldown) throw new Error('Provider 冷却不存在，无法设置 probe');
    upsertCooldownInDatabase(this.db, { ...cooldown, probeAttemptId: attemptId, updatedAt: now });
    this.db.saveToFile();
  }

  saveCooldown(cooldown: EngineProviderCooldown): void {
    upsertCooldownInDatabase(this.db, cooldown);
    this.db.saveToFile();
  }

  appendCapacityEvent(input: {
    resourceKey: string;
    attemptId: string | null;
    eventType: EngineCapacityEventType;
    occurredAt: number;
  }): void {
    appendCapacityEventInDatabase(this.db, { id: this.idFactory(), ...input });
    if (this.lastPrunedAt === null || input.occurredAt - this.lastPrunedAt >= 60 * 60_000) {
      pruneCapacityEventsInDatabase(this.db, input.occurredAt - 24 * 60 * 60_000);
      this.lastPrunedAt = input.occurredAt;
    }
    this.db.scheduleSaveToFile();
  }
}
