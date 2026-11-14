import { performance } from 'node:perf_hooks';
import type { NewsItemInput } from '../types.js';
import type { NewsRepository } from '../storage/news-repository.js';
import { fetchSource as defaultFetchSource } from '../sources/fetch-source.js';
import { isLocalRsshubUrl } from '../sources/rsshub-local.js';
import type { NewsSource, SourceFetchResult } from '../sources/source-types.js';
import { normalizeCandidate, isLikelyAi } from './normalizer.js';
import { chooseEventId } from './event-cluster.js';
import { inspectCapacity } from './capacity.js';

export interface NewsSchedulerOptions {
  repository: NewsRepository;
  sources: NewsSource[];
  dataDir?: string;
  fetchSource?: (source: NewsSource, options: { signal: AbortSignal; etag?: string; lastModified?: string }) => Promise<SourceFetchResult>;
  clock?: () => number;
  limits?: { maxConcurrent?: number };
  canWrite?: (items: NewsItemInput[]) => boolean;
}

export interface NewsSchedulerStatus {
  active: number;
  sources: Array<{ sourceId: string; nextFetchAt: number; lastError: string | null; failureCount: number }>;
}

export class NewsScheduler {
  private readonly options: NewsSchedulerOptions;
  private sources: NewsSource[];
  private readonly clock: () => number;
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private duePromise: Promise<void> | null = null;
  private ingestTail: Promise<void> = Promise.resolve();

  constructor(options: NewsSchedulerOptions) {
    this.options = options;
    this.sources = options.sources.filter((source) => source.enabled);
    this.clock = options.clock ?? Date.now;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const now = this.clock();
    this.sources.forEach((source, index) => {
      if (!this.options.repository.getSourceState(source.id)) this.options.repository.scheduleSource(source.id, now + (index + 1) * 60_000);
    });
    this.timer = setInterval(() => { void this.runDue(); }, 60_000);
    this.timer.unref?.();
  }

  replaceSources(sources: NewsSource[]): void {
    const next = sources.filter((source) => source.enabled);
    const enabled = new Set(next.map((source) => source.id));
    for (const [id, controller] of this.controllers) if (!enabled.has(id)) controller.abort();
    this.sources = next;
    if (this.started) next.forEach((source, index) => {
      if (!this.options.repository.getSourceState(source.id)) this.options.repository.scheduleSource(source.id, this.clock() + (index + 1) * 60_000);
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...(this.duePromise ? [this.duePromise] : []), ...this.active.values()]);
  }

  status(): NewsSchedulerStatus {
    return {
      active: this.active.size,
      sources: this.sources.map((source) => {
        const state = this.options.repository.getSourceState(source.id);
        return { sourceId: source.id, nextFetchAt: state?.nextFetchAt ?? 0, lastError: state?.lastError ?? null, failureCount: state?.failureCount ?? 0 };
      }),
    };
  }

  runDue(): Promise<void> {
    if (this.duePromise) return this.duePromise;
    const task = this.collectDue();
    this.duePromise = task.finally(() => { this.duePromise = null; });
    return this.duePromise;
  }

  private async collectDue(): Promise<void> {
    if (!this.started) return;
    const now = this.clock();
    const due = this.sources.filter((source) => {
      const state = this.options.repository.getSourceState(source.id);
      return !this.active.has(source.id) && (state?.nextFetchAt ?? Infinity) <= now;
    }).sort((a, b) => (this.options.repository.getSourceState(a.id)?.nextFetchAt ?? 0) - (this.options.repository.getSourceState(b.id)?.nextFetchAt ?? 0));
    const maxConcurrent = Math.min(2, Math.max(1, this.options.limits?.maxConcurrent ?? 2));
    for (let offset = 0; offset < due.length; offset += maxConcurrent) {
      await Promise.allSettled(due.slice(offset, offset + maxConcurrent).map((source) => this.runSource(source)));
    }
  }

  refreshSource(sourceId: string, actor: { id: string; role: string }): { accepted: boolean; reason?: string } {
    if (actor.role !== 'admin') return { accepted: false, reason: 'forbidden' };
    const source = this.sources.find((entry) => entry.id === sourceId);
    if (!source) return { accepted: false, reason: 'source_disabled_or_missing' };
    if (this.active.has(sourceId)) return { accepted: false, reason: 'running' };
    if (this.active.size >= Math.min(2, Math.max(1, this.options.limits?.maxConcurrent ?? 2))) return { accepted: false, reason: 'capacity' };
    const state = this.options.repository.getSourceState(sourceId);
    if (state?.lastCheckedAt && this.clock() - state.lastCheckedAt < 120_000) return { accepted: false, reason: 'cooldown' };
    void this.runSource(source).catch((error: unknown) => {
      console.warn('[News] 手动采集失败:', error instanceof Error ? error.message : String(error));
    });
    return { accepted: true };
  }

  private runSource(source: NewsSource): Promise<void> {
    const existing = this.active.get(source.id);
    if (existing) return existing;
    const task = this.collectSource(source).finally(() => { this.active.delete(source.id); });
    this.active.set(source.id, task);
    return task;
  }

  private async collectSource(source: NewsSource): Promise<void> {
    const checkedAt = this.clock();
    const startedAt = performance.now();
    const state = this.options.repository.getSourceState(source.id);
    const intervalMs = Math.max(15, source.intervalMinutes) * 60_000;
    const fetcher = this.options.fetchSource ?? defaultFetchSource;
    const controller = new AbortController();
    this.controllers.set(source.id, controller);
    const result = await fetcher(source, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(isLocalRsshubUrl(source.url) ? 30_000 : 8_000)]), etag: state?.etag ?? undefined, lastModified: state?.lastModified ?? undefined,
    }).catch((error: unknown): SourceFetchResult => ({ status: 'failed', candidates: [], etag: null, lastModified: null, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { this.controllers.delete(source.id); });
    const durationMs = Math.round(performance.now() - startedAt);
    if (result.status === 'rate_limited' || result.status === 'failed') {
      const backoff = Math.min(intervalMs * 2 ** Math.min(state?.failureCount ?? 0, 5), 6 * 60 * 60_000);
      this.options.repository.recordSourceAttempt({ sourceId: source.id, checkedAt, nextFetchAt: checkedAt + Math.max(backoff, result.retryAfterMs ?? 0), failed: true, error: result.error ?? result.status, durationMs, fetchedCount: 0 });
      return;
    }
    if (result.status === 'not_modified') {
      this.options.repository.recordSourceAttempt({ sourceId: source.id, checkedAt, nextFetchAt: checkedAt + intervalMs, failed: false, durationMs, fetchedCount: 0, etag: result.etag, lastModified: result.lastModified });
      return;
    }
    await this.serializeIngest(async () => {
      const recent: NewsItemInput[] = [];
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
        const page = await this.options.repository.list({ from: checkedAt - 72 * 60 * 60_000, to: checkedAt + 86_400_000, limit: 50, cursor });
        recent.push(...page.items.flatMap((event) => event.sources));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      const normalized: NewsItemInput[] = [];
      const seen = new Set<string>();
      for (const candidate of result.candidates.slice(0, 100)) {
        if (!isLikelyAi(candidate, source)) continue;
        try {
          const item = normalizeCandidate(candidate, source, checkedAt);
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          item.eventId = chooseEventId(item, [...recent, ...normalized]);
          normalized.push(item);
        } catch { /* 单条无效链接或标题不影响其他条目 */ }
      }
      const canWrite = this.options.canWrite ?? ((items: NewsItemInput[]) => inspectCapacity(this.options.dataDir ?? '', items).allowed);
      if (!canWrite(normalized)) {
        this.options.repository.recordSourceAttempt({ sourceId: source.id, checkedAt, nextFetchAt: checkedAt + intervalMs, failed: true, error: '磁盘剩余空间不足，已暂停新增采集', durationMs, fetchedCount: 0 });
        return;
      }
      await this.options.repository.upsertBatch({ sourceId: source.id, fetchedAt: checkedAt, nextFetchAt: checkedAt + intervalMs, items: normalized, etag: result.etag ?? undefined, lastModified: result.lastModified ?? undefined });
      this.options.repository.recordSourceAttempt({ sourceId: source.id, checkedAt, nextFetchAt: checkedAt + intervalMs, failed: false, durationMs, fetchedCount: normalized.length, etag: result.etag, lastModified: result.lastModified });
    });
  }

  private async serializeIngest(work: () => Promise<void>): Promise<void> {
    const previous = this.ingestTail;
    let release!: () => void;
    this.ingestTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { await work(); }
    finally { release(); }
  }
}

export function createNewsScheduler(options: NewsSchedulerOptions): NewsScheduler {
  return new NewsScheduler(options);
}
