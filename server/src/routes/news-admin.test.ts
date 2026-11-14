import assert from 'node:assert/strict';
import test from 'node:test';
import { createNewsAdminRouter } from './news-admin.js';

test('admin routes refuse members and cross-site writes, verify before enabling', async () => {
  let role: 'member' | 'admin' = 'member';
  let saves = 0;
  const source = { id: 'sample', name: 'Sample', kind: 'rss_atom', url: 'https://example.com/feed', allowedHosts: ['example.com'], enabled: true, intervalMinutes: 30, categoryId: 'research' };
  const repository = {
    listSources: () => [], getStatus: () => ({ available: true, version: 1, lastSuccessAt: null, loadedShards: [] }),
    getSourceState: () => null, getSourceItemCounts: () => ({ sample: 3 }), getGlobalPolicy: () => ({ blockedDomains: [], blockedKeywords: [], blockedUrls: [] }),
    listCategories: () => [], listAudit: () => [],
    saveSource: () => { saves++; },
  };
  const router = createNewsAdminRouter({ repository: () => repository as never, getActor: () => ({ userId: 'u1', role }), verifySource: async () => ({ status: 'ok', candidates: [], etag: null, lastModified: null }), originAllowed: (origin) => !origin || origin === 'https://relay.example' });
  assert.equal((await router.request('/sources')).status, 403);
  role = 'admin';
  assert.equal((await router.request('/sources')).status, 200);
  const body = JSON.stringify(source);
  assert.equal((await router.request('/sources', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body })).status, 403);
  assert.equal(saves, 0);
  assert.equal((await router.request('/sources', { method: 'POST', headers: { origin: 'https://relay.example', 'content-type': 'application/json' }, body })).status, 200);
  assert.equal(saves, 1);
});

test('来源列表返回逐来源累计入库数，未采集来源为零', async () => {
  const sources = ['a', 'b'].map((id) => ({ id, name: id, kind: 'rss_atom', url: 'https://example.com/feed', allowedHosts: ['example.com'], enabled: true, intervalMinutes: 30, categoryId: 'industry' }));
  const repository = {
    getStatus: () => ({ available: true }), listSources: () => sources,
    getSourceState: () => null, getSourceItemCounts: () => ({ a: 7 }),
  };
  const router = createNewsAdminRouter({ repository: () => repository as never, getActor: () => ({ userId: 'admin', role: 'admin' }) });
  const response = await router.request('/sources');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).sources.map((source: { totalItemCount: number }) => source.totalItemCount), [7, 0]);
});

test('policy preview marks a limited scan as incomplete', async () => {
  let calls = 0;
  const repository = {
    getStatus: () => ({ available: true, version: 1, lastSuccessAt: null, loadedShards: [] }),
    list: async () => { calls++; return { items: [], nextCursor: `page-${calls}`, version: 1 }; },
  };
  const router = createNewsAdminRouter({ repository: () => repository as never,
    getActor: () => ({ userId: 'admin', role: 'admin' }), originAllowed: () => true });
  const response = await router.request('/policy/preview', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blockedDomains: [], blockedKeywords: ['spam'], blockedUrls: [] }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).capped, true);
  assert.equal(calls, 10);
});

test('管理员可补录 AI 社交原帖，拒绝非官方域名和普通成员', async () => {
  let role: 'member' | 'admin' = 'member';
  let known = false;
  const inserted: Array<{ sourceId: string; items: Array<{ url: string; originalPublisher: string | null }> }> = [];
  const repository = {
    getStatus: () => ({ available: true, version: 1, lastSuccessAt: null, loadedShards: [] }),
    getStatistics: () => ({ itemCount: 0, shardCount: 0, bytes: 0, freeBytes: 1024 ** 3 }),
    list: async () => ({ items: [], nextCursor: null, version: 1 }),
    hasItemId: () => known,
    upsertBatch: async (batch: { sourceId: string; items: Array<{ url: string; originalPublisher: string | null }> }) => {
      inserted.push(batch); known = true; return { inserted: 1, version: 2 };
    },
    recordAudit: () => undefined,
  };
  const router = createNewsAdminRouter({ repository: () => repository as never,
    getActor: () => ({ userId: 'u1', role }), originAllowed: () => true });
  const body = JSON.stringify({ platform: 'weibo', url: 'https://weibo.com/123456/ABC', title: '某 AI 模型正式发布', author: '发布者', publishedAt: Date.now() - 60_000 });
  assert.equal((await router.request('/social-items', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 403);
  role = 'admin';
  assert.equal((await router.request('/social-items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body.replace('weibo.com', 'evil.example') })).status, 400);
  assert.equal(inserted.length, 0);
  assert.equal((await router.request('/social-items', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 201);
  assert.equal(inserted[0]?.sourceId, 'social-weibo');
  assert.equal(inserted[0]?.items[0]?.originalPublisher, '发布者');
  assert.equal((await router.request('/social-items', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 200);
  assert.equal(inserted.length, 1);
});
