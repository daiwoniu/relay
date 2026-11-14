import { randomUUID } from 'node:crypto';
import type { EngineProviderCooldown } from '../../db/engine-concurrency.js';
import { acceptCooldownProbe, computeOverloadCooldown, inspectCooldown } from './cooldown.js';
import type { EngineConcurrencyRepository, QueueClaimDispatcher } from './repository.js';

export interface ProviderTurnSchedulerOptions {
  repository: EngineConcurrencyRepository;
  dispatcher: QueueClaimDispatcher;
  now?: () => number;
  idFactory?: () => string;
  scheduleWake?: (resourceKey: string, delayMs: number) => void;
  onResourceChanged?: (resourceKey: string) => void;
}

export class ProviderTurnScheduler {
  private readonly drains = new Map<string, Promise<void>>();
  private readonly wakeAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly scheduleWakeCallback: (resourceKey: string, delayMs: number) => void;

  constructor(private readonly options: ProviderTurnSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.scheduleWakeCallback = options.scheduleWake ?? ((resourceKey, delayMs) => {
      const timer = setTimeout(() => {
        this.wakeAt.delete(resourceKey);
        void this.drain(resourceKey);
      }, delayMs);
      timer.unref?.();
    });
  }

  drain(resourceKey: string): Promise<void> {
    const previous = this.drains.get(resourceKey) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.drainLoop(resourceKey));
    const tracked = run.finally(() => {
      if (this.drains.get(resourceKey) === tracked) this.drains.delete(resourceKey);
    });
    this.drains.set(resourceKey, tracked);
    return tracked;
  }

  async onStartAccepted(resourceKey: string, attemptId: string): Promise<void> {
    const now = this.now();
    await this.options.repository.appendCapacityEvent({
      resourceKey, attemptId, eventType: 'start_accepted', occurredAt: now,
    });
    const cooldown = await this.options.repository.getCooldown(resourceKey);
    if (!cooldown || cooldown.probeAttemptId !== attemptId) {
      this.notifyResourceChanged(resourceKey);
      return;
    }
    await this.options.repository.saveCooldown(acceptCooldownProbe(cooldown, attemptId, now));
    this.notifyResourceChanged(resourceKey);
    this.wakeAt.delete(resourceKey);
    await this.drain(resourceKey);
  }

  async onCapacityRetry(resourceKey: string, attemptId: string, eventType: 'request_retry' | 'completion_retry'): Promise<void> {
    await this.options.repository.appendCapacityEvent({ resourceKey, attemptId, eventType, occurredAt: this.now() });
    this.notifyResourceChanged(resourceKey);
  }

  async onProviderOverload(resourceKey: string, attemptId: string, retryAfterMs: number | null): Promise<void> {
    const now = this.now();
    const previous = await this.options.repository.getCooldown(resourceKey);
    const cooldown = computeOverloadCooldown(resourceKey, previous, now, retryAfterMs);
    await this.options.repository.saveCooldown(cooldown);
    await this.options.repository.appendCapacityEvent({
      resourceKey, attemptId, eventType: 'overload', occurredAt: now,
    });
    await this.options.repository.appendCapacityEvent({
      resourceKey, attemptId, eventType: 'cooldown_started', occurredAt: now,
    });
    this.notifyResourceChanged(resourceKey);
    this.scheduleWake(resourceKey, cooldown.cooldownUntil! - now);
  }

  private async drainLoop(resourceKey: string): Promise<void> {
    while (true) {
      const now = this.now();
      const cooldown = await this.options.repository.getCooldown(resourceKey);
      const inspection = inspectCooldown(cooldown, now);
      if (inspection.state === 'blocked') {
        this.scheduleWake(resourceKey, inspection.retryAfterMs);
        return;
      }
      if (inspection.state === 'probe_in_progress') return;

      const maxActiveTurns = await this.options.repository.getMaxActiveTurns(resourceKey);
      if (!Number.isSafeInteger(maxActiveTurns) || maxActiveTurns < 1) return;
      const claim = await this.options.repository.claimNext({
        resourceKey,
        maxActiveTurns,
        claimToken: this.idFactory(),
        now,
      });
      if (!claim) return;

      const isProbe = inspection.state === 'probe_required';
      if (isProbe) await this.options.repository.setProbe(resourceKey, claim.queue.attemptId, now);
      await this.options.repository.appendCapacityEvent({
        resourceKey,
        attemptId: claim.queue.attemptId,
        eventType: 'start_claimed',
        occurredAt: now,
      });
      this.notifyResourceChanged(resourceKey);
      try {
        await this.options.dispatcher.start(claim);
      } catch (error) {
        await this.options.dispatcher.fail(claim, error);
        if (isProbe && cooldown) {
          const clearedProbe: EngineProviderCooldown = { ...cooldown, probeAttemptId: null, updatedAt: this.now() };
          await this.options.repository.saveCooldown(clearedProbe);
          this.notifyResourceChanged(resourceKey);
          return;
        }
        continue;
      }
      if (isProbe) return;
    }
  }

  private scheduleWake(resourceKey: string, delayMs: number): void {
    const boundedDelay = Math.max(0, Math.trunc(delayMs));
    const target = this.now() + boundedDelay;
    const existing = this.wakeAt.get(resourceKey);
    if (existing !== undefined && existing <= target) return;
    this.wakeAt.set(resourceKey, target);
    this.scheduleWakeCallback(resourceKey, boundedDelay);
  }

  private notifyResourceChanged(resourceKey: string): void {
    try { this.options.onResourceChanged?.(resourceKey); } catch { /* 只读广播不能中断调度 */ }
  }
}
