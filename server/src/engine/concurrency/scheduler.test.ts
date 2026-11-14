import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  EngineCapacityEventType,
  EngineProviderCooldown,
  EngineQueueEntry,
  EngineResourceLease,
} from '../../db/engine-concurrency.js';
import type { EngineConcurrencyRepository, QueueClaim } from './repository.js';
import { ProviderTurnScheduler } from './scheduler.js';

function queued(resourceKey: string, attemptId: string, createdAt: number): EngineQueueEntry {
  const engineId = resourceKey.startsWith('codebuddy:') ? 'codebuddy' : 'codex';
  return {
    id: `queue-${attemptId}`, sessionId: `session-${attemptId}`, attemptId,
    userMessageId: `message-${attemptId}`, engineId, resourceKey, requestedByUserId: 'user-1',
    state: 'queued', claimToken: null, createdAt, claimedAt: null,
  };
}

class FakeRepository implements EngineConcurrencyRepository {
  readonly queues = new Map<string, EngineQueueEntry[]>();
  readonly active = new Map<string, number>();
  readonly limits = new Map<string, number>();
  readonly cooldowns = new Map<string, EngineProviderCooldown>();
  readonly events: Array<{ resourceKey: string; attemptId: string | null; eventType: EngineCapacityEventType }> = [];

  enqueue(resourceKey: string, ...entries: EngineQueueEntry[]) {
    this.queues.set(resourceKey, [...(this.queues.get(resourceKey) || []), ...entries]);
  }

  async getMaxActiveTurns(resourceKey: string) { return this.limits.get(resourceKey) ?? 1; }
  async getCooldown(resourceKey: string) { return this.cooldowns.get(resourceKey) ?? null; }
  async claimNext(input: { resourceKey: string; maxActiveTurns: number; claimToken: string; now: number }): Promise<QueueClaim | null> {
    const active = this.active.get(input.resourceKey) ?? 0;
    if (active >= input.maxActiveTurns) return null;
    const queue = this.queues.get(input.resourceKey)?.shift();
    if (!queue) return null;
    const claimedQueue = { ...queue, state: 'claimed' as const, claimToken: input.claimToken, claimedAt: input.now };
    const lease: EngineResourceLease = {
      attemptId: queue.attemptId, sessionId: queue.sessionId, engineId: queue.engineId,
      resourceKey: queue.resourceKey, leaseToken: input.claimToken, state: 'claimed', acquiredAt: input.now, startedAt: null,
    };
    this.active.set(input.resourceKey, active + 1);
    return { queue: claimedQueue, lease };
  }
  async setProbe(resourceKey: string, attemptId: string, now: number) {
    const current = this.cooldowns.get(resourceKey);
    if (!current) throw new Error('missing cooldown');
    this.cooldowns.set(resourceKey, { ...current, probeAttemptId: attemptId, updatedAt: now });
  }
  async saveCooldown(cooldown: EngineProviderCooldown) { this.cooldowns.set(cooldown.resourceKey, cooldown); }
  async appendCapacityEvent(input: { resourceKey: string; attemptId: string | null; eventType: EngineCapacityEventType }) {
    this.events.push(input);
  }
}

test('同 key 并发 drain 不超额且严格 FIFO', async () => {
  const repository = new FakeRepository();
  repository.limits.set('codex:default', 2);
  repository.enqueue('codex:default', queued('codex:default', 'a1', 1), queued('codex:default', 'a2', 2), queued('codex:default', 'a3', 3));
  const started: string[] = [];
  const scheduler = new ProviderTurnScheduler({
    repository,
    dispatcher: { start: async (claim) => { started.push(claim.queue.attemptId); }, fail: async () => undefined },
    idFactory: (() => { let id = 0; return () => `claim-${++id}`; })(),
  });

  await Promise.all([scheduler.drain('codex:default'), scheduler.drain('codex:default')]);
  assert.deepEqual(started, ['a1', 'a2']);
  assert.equal(repository.active.get('codex:default'), 2);
  assert.deepEqual(repository.queues.get('codex:default')?.map((entry) => entry.attemptId), ['a3']);
});

test('不同资源独立 drain，调低不打断且调高后补位', async () => {
  const repository = new FakeRepository();
  repository.limits.set('codex:default', 1);
  repository.limits.set('codebuddy:default', 1);
  repository.enqueue('codex:default', queued('codex:default', 'c1', 1), queued('codex:default', 'c2', 2));
  repository.enqueue('codebuddy:default', queued('codebuddy:default', 'b1', 1));
  const started: string[] = [];
  const scheduler = new ProviderTurnScheduler({
    repository,
    dispatcher: { start: async (claim) => { started.push(claim.queue.attemptId); }, fail: async () => undefined },
  });
  await Promise.all([scheduler.drain('codex:default'), scheduler.drain('codebuddy:default')]);
  assert.deepEqual(new Set(started), new Set(['c1', 'b1']));
  repository.limits.set('codex:default', 0 as never);
  await scheduler.drain('codex:default');
  assert.equal(repository.active.get('codex:default'), 1);
  repository.limits.set('codex:default', 2);
  await scheduler.drain('codex:default');
  assert.ok(started.includes('c2'));
});

test('冷却到期只放行 probe，接受后再补满剩余槽位', async () => {
  let now = 10_000;
  const repository = new FakeRepository();
  repository.limits.set('codex:default', 2);
  repository.enqueue('codex:default', queued('codex:default', 'a1', 1), queued('codex:default', 'a2', 2));
  repository.cooldowns.set('codex:default', {
    resourceKey: 'codex:default', consecutiveOverloads: 1, cooldownUntil: 20_000,
    probeAttemptId: null, lastOverloadAt: 1_000, lastSuccessAt: null, updatedAt: 1_000,
  });
  const started: string[] = [];
  const wakes: Array<{ resourceKey: string; delayMs: number }> = [];
  const scheduler = new ProviderTurnScheduler({
    repository,
    dispatcher: { start: async (claim) => { started.push(claim.queue.attemptId); }, fail: async () => undefined },
    now: () => now,
    scheduleWake: (resourceKey, delayMs) => { wakes.push({ resourceKey, delayMs }); },
  });
  await scheduler.drain('codex:default');
  assert.deepEqual(started, []);
  assert.deepEqual(wakes, [{ resourceKey: 'codex:default', delayMs: 10_000 }]);
  now = 20_000;
  await scheduler.drain('codex:default');
  assert.deepEqual(started, ['a1']);
  assert.equal(repository.cooldowns.get('codex:default')?.probeAttemptId, 'a1');
  await scheduler.onStartAccepted('codex:default', 'a1');
  assert.deepEqual(started, ['a1', 'a2']);
  assert.equal(repository.cooldowns.get('codex:default')?.consecutiveOverloads, 0);
});

test('dispatcher 失败会收口 claim 并继续派发下一项', async () => {
  const repository = new FakeRepository();
  repository.limits.set('codex:default', 1);
  repository.enqueue('codex:default', queued('codex:default', 'a1', 1), queued('codex:default', 'a2', 2));
  const started: string[] = [];
  const failed: string[] = [];
  const scheduler = new ProviderTurnScheduler({
    repository,
    dispatcher: {
      start: async (claim) => {
        started.push(claim.queue.attemptId);
        if (claim.queue.attemptId === 'a1') throw new Error('start failed');
      },
      fail: async (claim) => {
        failed.push(claim.queue.attemptId);
        repository.active.set(claim.queue.resourceKey, (repository.active.get(claim.queue.resourceKey) || 1) - 1);
      },
    },
  });
  await scheduler.drain('codex:default');
  assert.deepEqual(started, ['a1', 'a2']);
  assert.deepEqual(failed, ['a1']);
});

test('最终过载写入持久化冷却并只调度对应资源唤醒', async () => {
  let now = 1_000;
  const repository = new FakeRepository();
  const wakes: Array<{ resourceKey: string; delayMs: number }> = [];
  const scheduler = new ProviderTurnScheduler({
    repository,
    dispatcher: { start: async () => undefined, fail: async () => undefined },
    now: () => now,
    scheduleWake: (resourceKey, delayMs) => { wakes.push({ resourceKey, delayMs }); },
  });
  await scheduler.onProviderOverload('codex:default', 'a1', null);
  assert.equal(repository.cooldowns.get('codex:default')?.cooldownUntil, 31_000);
  assert.deepEqual(wakes, [{ resourceKey: 'codex:default', delayMs: 30_000 }]);
  now = 40_000;
  await scheduler.onProviderOverload('codex:default', 'a2', 90_000);
  assert.equal(repository.cooldowns.get('codex:default')?.cooldownUntil, 130_000);
  assert.equal(repository.events.filter((event) => event.eventType === 'overload').length, 2);
});

test('内部重试只记录容量窗口，最终过载才启动冷却并通知资源变化', async () => {
  const repository = new FakeRepository();
  const changed: string[] = [];
  const scheduler = new ProviderTurnScheduler({
    repository,
    dispatcher: { start: async () => undefined, fail: async () => undefined },
    now: () => 1_000,
    scheduleWake: () => undefined,
    onResourceChanged: (resourceKey) => changed.push(resourceKey),
  });
  await scheduler.onCapacityRetry('codex:default', 'a1', 'request_retry');
  await scheduler.onCapacityRetry('codex:default', 'a1', 'completion_retry');
  assert.equal(repository.cooldowns.size, 0);
  assert.deepEqual(repository.events.map((event) => event.eventType), ['request_retry', 'completion_retry']);
  await scheduler.onProviderOverload('codex:default', 'a1', null);
  assert.equal(repository.cooldowns.has('codex:default'), true);
  assert.deepEqual(changed, ['codex:default', 'codex:default', 'codex:default']);
});
