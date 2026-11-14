import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { openNewsRepository } from '../src/news/storage/news-repository.js';

const root = path.resolve('..', '.relay-dev', 'news-resource-bench');
fs.mkdirSync(root, { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'case-'));
if (!fixture.startsWith(`${root}${path.sep}`)) throw new Error('基准目录越界');
const newsDir = path.join(fixture, 'news');
const relayDb = path.join(fixture, 'relay.db');
fs.writeFileSync(relayDb, Buffer.alloc(512));
const mainBefore = fs.statSync(relayDb).size;
const started = performance.now();
let repo;
try {
  repo = await openNewsRepository(newsDir);
  const sources = Array.from({ length: 12 }, (_, index) => ({
    id: `source-${index}`, name: `Source ${index}`, kind: 'rss_atom',
    url: `https://example.com/feed/${index}`, allowedHosts: ['example.com'],
    enabled: true, intervalMinutes: 60, categoryId: 'industry',
  }));
  repo.ensureSources(sources);
  const base = Date.parse('2026-09-20T00:00:00Z');
  const batches = sources.map((source, sourceIndex) => ({
    sourceId: source.id, fetchedAt: base + 30 * 86_400_000, nextFetchAt: base + 30 * 86_400_000 + 60_000,
    items: Array.from({ length: 100 }, (_, itemIndex) => {
      const sequence = sourceIndex * 100 + itemIndex;
      const time = base + (sequence < 600 ? sequence * 60_000 : 30 * 86_400_000 + (sequence - 600) * 60_000);
      return {
        id: sequence.toString(16).padStart(32, '0'), eventId: sequence.toString(16).padStart(32, '0'),
        sourceId: source.id, url: `https://example.com/news/${sequence}`, title: `AI model update ${sequence}`,
        description: `Benchmark item ${sequence}`, publishedAt: time, firstFetchedAt: time,
        categoryId: 'industry', topicIds: ['agent'], entityIds: [], eventTypeId: 'update', language: 'en',
      };
    }),
  }));
  const ingestStart = performance.now();
  for (const batch of batches) await repo.upsertBatch(batch);
  const ingestMs = performance.now() - ingestStart;
  const queryStart = performance.now();
  const page = await repo.list({ from: base + 30 * 86_400_000, to: base + 31 * 86_400_000, limit: 20 });
  const firstPageMs = performance.now() - queryStart;
  const secondStart = performance.now();
  const second = await repo.list({ from: base + 30 * 86_400_000, to: base + 31 * 86_400_000, limit: 20, cursor: page.nextCursor ?? undefined });
  const secondPageMs = performance.now() - secondStart;
  const storage = repo.getStatistics();
  await repo.close(); repo = undefined;
  // maxRSS is recorded by the OS, including synchronous sql.js work that timers cannot observe.
  const peakRss = process.resourceUsage().maxRSS * 1024;
  const result = {
    environment: `${process.platform}/${process.arch} Node ${process.version}`,
    sources: sources.length, shards: storage.shardCount, items: storage.itemCount,
    ingestMs: Number(ingestMs.toFixed(1)), firstPageMs: Number(firstPageMs.toFixed(1)), secondPageMs: Number(secondPageMs.toFixed(1)),
    firstPageItems: page.items.length, secondPageItems: second.items.length,
    peakRssMiB: Number((peakRss / 1024 / 1024).toFixed(1)),
    newsBytes: storage.bytes, mainDbSizeDelta: fs.statSync(relayDb).size - mainBefore,
    elapsedMs: Number((performance.now() - started).toFixed(1)),
  };
  console.log(JSON.stringify(result));
} finally {
  await repo?.close();
  fs.rmSync(fixture, { recursive: true, force: true });
}
