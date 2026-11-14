import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { openNewsRepository } from '../storage/news-repository.js';
import type { NewsItemInput } from '../types.js';

test('固定 100 条样本的批量入库与近期列表耗时', async (context) => {
  const root = path.resolve('..', '.relay-dev', 'news-ingest-tests');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'bench-'));
  try {
    const repo = await openNewsRepository(dir);
    const base = Date.parse('2026-10-15T10:00:00Z');
    const items: NewsItemInput[] = Array.from({ length: 100 }, (_, index) => ({
      id: `bench-${index}`, eventId: `bench-${index}`, sourceId: 'bench',
      url: `https://example.org/${index}`, title: `AI item ${index}`, description: null,
      publishedAt: base - index * 1000, firstFetchedAt: base,
      categoryId: 'other', topicIds: [], entityIds: [], eventTypeId: null, language: 'en',
    }));
    const insertStart = performance.now();
    await repo.upsertBatch({ sourceId: 'bench', fetchedAt: base, nextFetchAt: base + 60_000, items });
    const insertMs = performance.now() - insertStart;
    const queryStart = performance.now();
    const page = await repo.list({ from: base - 86_400_000, to: base, limit: 20 });
    const queryMs = performance.now() - queryStart;
    assert.equal(page.items.length, 20);
    context.diagnostic(`100 条：批量入库 ${insertMs.toFixed(1)} ms，近期首屏 ${queryMs.toFixed(1)} ms；Node ${process.version}，${process.platform}/${process.arch}`);
    await repo.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
