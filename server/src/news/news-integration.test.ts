import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { openNewsRepository } from './storage/news-repository.js';
import { createPublicNewsRouter } from '../routes/news-public.js';
import { createNewsPreferencesRouter } from '../routes/news-preferences.js';
import type { NewsItemInput } from './types.js';

const root = path.resolve('..', '.relay-dev', 'news-integration-tests');
function fixture() { fs.mkdirSync(root, { recursive: true }); return fs.mkdtempSync(path.join(root, 'case-')); }
function item(id: string, at: number): NewsItemInput {
  return { id, eventId: id, sourceId: 'sample', url: `https://example.com/${id}`, title: 'AI agent release', description: null, publishedAt: at, firstFetchedAt: at, categoryId: 'research', topicIds: ['agent'], entityIds: ['openai'], eventTypeId: 'release', language: 'en' };
}
const source = { id: 'sample', name: 'Sample', kind: 'rss_atom' as const, url: 'https://example.com/feed', allowedHosts: ['example.com'], enabled: false, intervalMinutes: 60, categoryId: 'research' };

test('quiesced backup restores source, policy, preferences and cross-month history', async () => {
  const dir = fixture();
  const backup = fixture();
  try {
    const repo = await openNewsRepository(dir);
    const january = Date.parse('2026-01-31T23:00:00Z');
    const february = Date.parse('2026-02-01T01:00:00Z');
    repo.ensureSources([source]);
    repo.saveGlobalPolicy({ blockedDomains: [], blockedKeywords: ['spam'], blockedUrls: [] }, 'admin');
    repo.saveUserPreferences('member-a', { rules: [{ id: 'follow', kind: 'follow', topic: 'agent' }] });
    await repo.upsertBatch({ sourceId: 'sample', fetchedAt: february, nextFetchAt: february + 60_000, items: [item('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', january), item('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', february)] });
    await repo.close();
    for (const name of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, name), path.join(backup, name));
    const restored = await openNewsRepository(backup);
    assert.equal(restored.listSources()[0]?.id, 'sample');
    assert.deepEqual(restored.getGlobalPolicy().blockedKeywords, ['spam']);
    assert.equal(restored.getUserPreferences('member-a').rules[0]?.topic, 'agent');
    assert.deepEqual((await restored.list({ from: january - 1000, to: february + 1000, limit: 20 })).items.map((entry) => entry.id), ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    assert.equal(fs.existsSync(path.join(backup, 'relay.db')), false);
    await restored.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(backup, { recursive: true, force: true }); }
});

test('damaged monthly shard cannot alter Relay main database', async () => {
  const dir = fixture();
  try {
    const main = path.join(dir, 'relay.db');
    fs.writeFileSync(main, 'relay-main-marker');
    const repo = await openNewsRepository(dir);
    const when = Date.parse('2026-03-05T00:00:00Z');
    await repo.upsertBatch({ sourceId: 'sample', fetchedAt: when, nextFetchAt: when + 60_000, items: [item('cccccccccccccccccccccccccccccccc', when)] });
    await repo.close();
    fs.writeFileSync(path.join(dir, 'news-2026-03.db'), 'damaged-shard');
    const reopened = await openNewsRepository(dir);
    assert.equal(reopened.getStatistics().itemCount, 1);
    await assert.rejects(reopened.list({ from: when - 1000, to: when + 1000, limit: 20 }));
    assert.equal(fs.readFileSync(main, 'utf8'), 'relay-main-marker');
    await reopened.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('anonymous and distinct member feeds can read concurrently', async () => {
  const dir = fixture();
  try {
    const repo = await openNewsRepository(dir);
    const now = Date.now();
    repo.ensureSources([source]);
    repo.saveUserPreferences('a', { rules: [{ id: 'follow', kind: 'follow', topic: 'agent' }] });
    repo.saveUserPreferences('b', { rules: [{ id: 'mute', kind: 'mute', topic: 'agent' }] });
    await repo.upsertBatch({ sourceId: 'sample', fetchedAt: now, nextFetchAt: now + 60_000, items: [item('dddddddddddddddddddddddddddddddd', now - 1000)] });
    const publicRouter = createPublicNewsRouter({ repository: () => repo, getClientId: () => 'integration', now: () => now });
    let userId = 'a';
    const memberRouter = createNewsPreferencesRouter({ repository: () => repo, getActor: (c) => ({ userId: c.req.header('x-user') ?? userId, role: 'member' }), now: () => now });
    const responses = await Promise.all(Array.from({ length: 18 }, (_, index) => index % 3 === 0
      ? publicRouter.request('/') : memberRouter.request('/?view=all', { headers: { 'x-user': index % 3 === 1 ? 'a' : 'b' } })));
    assert.ok(responses.every((response) => response.status === 200));
    const pages = await Promise.all(responses.map((response) => response.json()));
    assert.equal(pages[0].items.length, 1);
    assert.equal(pages[1].items.length, 1);
    assert.equal(pages[2].items.length, 0);
    await repo.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('admin corrections determine public and member filters and every source label', async () => {
  const dir = fixture();
  try {
    const repo = await openNewsRepository(dir);
    const now = Date.now();
    const corrected = item('corrected', now - 1000);
    repo.ensureSources([source]);
    await repo.upsertBatch({ sourceId: 'sample', fetchedAt: now, nextFetchAt: now + 60_000, items: [corrected] });
    repo.saveCorrection(corrected.id, { hidden: false, categoryId: 'industry', topicIds: ['coding'], entityIds: ['microsoft'], eventTypeId: 'update' }, 'admin');
    repo.saveUserPreferences('a', { rules: [{ id: 'coding', kind: 'follow', topic: 'coding' }] });
    const publicRouter = createPublicNewsRouter({ repository: () => repo, getClientId: () => 'correction', now: () => now });
    const memberRouter = createNewsPreferencesRouter({ repository: () => repo, getActor: () => ({ userId: 'a', role: 'member' }), now: () => now });
    for (const query of ['category=industry', 'topic=coding', 'entity=microsoft', 'eventType=update']) {
      for (const router of [publicRouter, memberRouter]) {
        const body = await (await router.request(`/?${query}`)).json();
        assert.equal(body.items[0]?.sources[0]?.categoryId, 'industry');
        assert.deepEqual(body.items[0]?.sources[0]?.topicIds, ['coding']);
      }
    }
    assert.equal((await (await publicRouter.request('/?category=research')).json()).items.length, 0);
    const stats = await (await memberRouter.request('/preferences/matches')).json();
    assert.equal(stats.counts.coding, 1);
    await repo.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('anonymous feed reuses results until the news version changes', async () => {
  const dir = fixture();
  try {
    const repo = await openNewsRepository(dir);
    let now = Math.floor(Date.now() / 30_000) * 30_000 + 1000;
    repo.ensureSources([source]);
    await repo.upsertBatch({ sourceId: 'sample', fetchedAt: now, nextFetchAt: now + 60_000, items: [item('first', now - 1000)] });
    let listCalls = 0;
    const router = createPublicNewsRouter({ repository: () => ({
      getStatus: () => repo.getStatus(), getSourceState: (id: string) => repo.getSourceState(id),
      listSources: () => repo.listSources(), listCategories: () => repo.listCategories(),
      getGlobalPolicy: () => repo.getGlobalPolicy(), getCorrection: (id: string) => repo.getCorrection(id),
      list: async (options: Parameters<typeof repo.list>[0]) => { listCalls++; return repo.list(options); },
    }), getClientId: () => 'cache', now: () => now });
    await router.request('/');
    now += 1000;
    await router.request('/');
    assert.equal(listCalls, 1);
    repo.saveCorrection('first', { hidden: true }, 'admin');
    await router.request('/');
    assert.ok(listCalls > 1);
    await repo.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
