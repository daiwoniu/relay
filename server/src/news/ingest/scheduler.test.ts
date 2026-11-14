import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openNewsRepository } from '../storage/news-repository.js';
import { createNewsScheduler } from './scheduler.js';
import type { NewsSource, SourceFetchResult } from '../sources/source-types.js';
import type { NewsItemInput } from '../types.js';

function fixtureDirectory(): string {
  const root = path.resolve('..', '.relay-dev', 'news-ingest-tests');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'case-'));
}

function source(id: string): NewsSource {
  return { id, name: id, kind: 'rss_atom', url: `https://example.org/${id}`, allowedHosts: ['example.org'], enabled: true, intervalMinutes: 15, categoryId: 'industry' };
}

function fetched(id: string, at: number): SourceFetchResult {
  return { status: 'ok', etag: null, lastModified: null, candidates: [{ sourceId: id, rawUrl: '/release', baseUrl: `https://example.org/${id}`, title: 'OpenAI releases new model Orion', description: 'AI model', rawPublishedAt: new Date(at).toISOString() }] };
}

test('归并候选会跨过最近 50 条事件', async () => {
  const dir = fixtureDirectory();
  try {
    const now = Date.parse('2026-10-15T10:00:00Z');
    const repo = await openNewsRepository(dir);
    const older: NewsItemInput = {
      id: 'older', eventId: 'shared-event', sourceId: 'one', url: 'https://example.org/older',
      title: 'OpenAI releases new model Orion', description: 'AI model', publishedAt: now - 61 * 60_000,
      firstFetchedAt: now - 61 * 60_000, categoryId: 'industry', topicIds: [], entityIds: ['openai'],
      eventTypeId: 'release', language: 'en',
    };
    const newer = Array.from({ length: 60 }, (_, index): NewsItemInput => ({
      ...older, id: `filler-${index}`, eventId: `filler-${index}`, title: `AI tooling update ${index}`,
      url: `https://example.org/filler-${index}`, publishedAt: now - index * 60_000,
    }));
    await repo.upsertBatch({ sourceId: 'one', fetchedAt: now, nextFetchAt: now, items: [older, ...newer] });
    const scheduler = createNewsScheduler({ repository: repo, sources: [source('two')], clock: () => now,
      fetchSource: async () => fetched('two', now), canWrite: () => true });
    scheduler.start();
    const due = scheduler.status().sources[0]!.nextFetchAt;
    await scheduler.stop();
    const running = createNewsScheduler({ repository: repo, sources: [source('two')], clock: () => due,
      fetchSource: async () => fetched('two', now), canWrite: () => true });
    running.start();
    await running.runDue();
    const page = await repo.list({ from: now - 2 * 60 * 60_000, to: now + 1000, limit: 50 });
    const merged = page.items.find((event) => event.eventId === 'shared-event');
    assert.equal(merged?.sources.length, 2);
    await running.stop();
    await repo.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('首次启动错峰且持久恢复下次抓取，不立即齐发来源', async () => {
  const dir = fixtureDirectory();
  try {
    let now = Date.parse('2026-10-15T10:00:00Z');
    const repo = await openNewsRepository(dir);
    const calls: string[] = [];
    const scheduler = createNewsScheduler({ repository: repo, sources: [source('one'), source('two')], clock: () => now, fetchSource: async (entry) => { calls.push(entry.id); return fetched(entry.id, now); }, limits: { maxConcurrent: 2 }, canWrite: () => true });
    scheduler.start();
    await scheduler.runDue();
    assert.deepEqual(calls, []);
    const due = scheduler.status().sources.map((entry) => entry.nextFetchAt);
    assert.ok(due[0] > now && due[1] > due[0]);
    now = due[0];
    await scheduler.runDue();
    assert.deepEqual(calls, ['one']);
    await scheduler.stop();
    await repo.close();

    const reopened = await openNewsRepository(dir);
    const resumed = createNewsScheduler({ repository: reopened, sources: [source('one'), source('two')], clock: () => now, fetchSource: async () => fetched('one', now), limits: { maxConcurrent: 2 }, canWrite: () => true });
    resumed.start();
    assert.equal(resumed.status().sources.find((entry) => entry.sourceId === 'one')?.nextFetchAt, reopened.getSourceState('one')?.nextFetchAt);
    await resumed.stop();
    await reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('304 不递增资讯版本，429 退避且失败来源不阻断其他来源', async () => {
  const dir = fixtureDirectory();
  try {
    let now = Date.parse('2026-10-15T10:00:00Z');
    const repo = await openNewsRepository(dir);
    let oneCalls = 0;
    const scheduler = createNewsScheduler({ repository: repo, sources: [source('one'), source('two')], clock: () => now, fetchSource: async (entry) => {
      if (entry.id === 'one') { oneCalls += 1; return oneCalls === 1 ? fetched('one', now) : { status: 'not_modified', candidates: [], etag: null, lastModified: null }; }
      return { status: 'rate_limited', candidates: [], etag: null, lastModified: null, retryAfterMs: 3_600_000 };
    }, limits: { maxConcurrent: 2 }, canWrite: () => true });
    scheduler.start();
    now += 15 * 60_000;
    await scheduler.runDue();
    assert.equal(repo.getStatus().version, 1);
    const firstSuccess = repo.getSourceState('one')?.lastSuccessAt;
    assert.equal(repo.getSourceState('two')?.lastSuccessAt, null);
    assert.ok((repo.getSourceState('two')?.nextFetchAt ?? 0) >= now + 3_600_000);
    now += 15 * 60_000;
    await scheduler.runDue();
    assert.equal(repo.getStatus().version, 1);
    assert.equal(repo.getSourceState('one')?.lastSuccessAt, firstSuccess);
    await scheduler.stop();
    await repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('磁盘不足暂停新增但保留既有可读内容，管理员刷新受冷却约束', async () => {
  const dir = fixtureDirectory();
  try {
    let now = Date.parse('2026-10-15T10:00:00Z');
    const repo = await openNewsRepository(dir);
    let available = true;
    const scheduler = createNewsScheduler({ repository: repo, sources: [source('one')], clock: () => now, fetchSource: async () => fetched('one', now), limits: { maxConcurrent: 2 }, canWrite: () => available });
    scheduler.start();
    now += 15 * 60_000;
    await scheduler.runDue();
    assert.equal(repo.getStatus().version, 1);
    available = false;
    now += 15 * 60_000;
    await scheduler.runDue();
    assert.equal(repo.getStatus().version, 1);
    assert.equal((await repo.list({ from: now - 60 * 60_000, to: now, limit: 20 })).items.length, 1);
    assert.equal(scheduler.refreshSource('one', { id: 'admin', role: 'admin' }).accepted, false);
    await scheduler.stop();
    await repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('两个重叠轮询也不超过全局两源并发上限', async () => {
  const dir = fixtureDirectory();
  try {
    let now = Date.parse('2026-10-15T10:00:00Z');
    const repo = await openNewsRepository(dir);
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const scheduler = createNewsScheduler({ repository: repo, sources: [source('one'), source('two'), source('three')], clock: () => now, fetchSource: async (entry) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return fetched(entry.id, now);
    }, limits: { maxConcurrent: 2 }, canWrite: () => true });
    scheduler.start();
    now += 15 * 60_000;
    const first = scheduler.runDue();
    await new Promise((resolve) => setImmediate(resolve));
    const second = scheduler.runDue();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(peak, 2);
    assert.equal(releases.length, 2);
    while (releases.length) releases.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    while (releases.length) releases.shift()!();
    await Promise.all([first, second]);
    assert.equal(peak, 2);
    await scheduler.stop();
    await repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('关闭调度器会取消进行中的来源请求', async () => {
  const dir = fixtureDirectory();
  try {
    let now = Date.parse('2026-10-15T10:00:00Z');
    const repo = await openNewsRepository(dir);
    let cancelled = false;
    const scheduler = createNewsScheduler({ repository: repo, sources: [source('one')], clock: () => now, fetchSource: async (_entry, options) => new Promise((resolve) => {
      options.signal.addEventListener('abort', () => { cancelled = true; resolve({ status: 'failed', candidates: [], etag: null, lastModified: null, error: 'cancelled' }); }, { once: true });
    }), limits: { maxConcurrent: 2 }, canWrite: () => true });
    scheduler.start();
    now += 15 * 60_000;
    const pending = scheduler.runDue();
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.race([scheduler.stop(), new Promise((_, reject) => setTimeout(() => reject(new Error('关闭未取消抓取')), 500))]);
    await pending;
    assert.equal(cancelled, true);
    await repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('并发抓取的跨月相似报道串行入库并合成一张卡', async () => {
  const dir = fixtureDirectory();
  try {
    let now = Date.parse('2026-02-01T01:00:00Z');
    const repo = await openNewsRepository(dir);
    const scheduler = createNewsScheduler({ repository: repo, sources: [source('one'), source('two')], clock: () => now, fetchSource: async (entry) => ({
      status: 'ok', etag: null, lastModified: null,
      candidates: [{ sourceId: entry.id, baseUrl: entry.url, rawUrl: `/${entry.id}`, title: 'OpenAI releases new model Orion', description: 'AI model', rawPublishedAt: entry.id === 'one' ? '2026-01-31T23:30:00Z' : '2026-02-01T00:30:00Z' }],
    }), limits: { maxConcurrent: 2 }, canWrite: () => true });
    scheduler.start();
    now += 15 * 60_000;
    await scheduler.runDue();
    const page = await repo.list({ from: Date.parse('2026-01-31T23:00:00Z'), to: now, limit: 20 });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.sources.length, 2);
    await scheduler.stop();
    await repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
