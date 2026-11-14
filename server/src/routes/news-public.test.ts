import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { isUnauthenticatedApiRequest } from '../auth/public-paths.js';
import { createPublicNewsRouter } from './news-public.js';

test('only GET public news endpoints bypass user session, never the internal token', async () => {
  assert.equal(isUnauthenticatedApiRequest('GET', '/api/public/news'), true);
  assert.equal(isUnauthenticatedApiRequest('GET', '/api/public/news/version'), true);
  assert.equal(isUnauthenticatedApiRequest('POST', '/api/public/news'), false);
  assert.equal(isUnauthenticatedApiRequest('GET', '/api/news'), false);
  const app = new Hono();
  app.use('/api/*', async (c, next) => c.req.header('x-relay-token') === 'internal' ? next() : c.json({ error: 'unauthorized' }, 401));
  app.use('/api/*', async (c, next) => isUnauthenticatedApiRequest(c.req.method, c.req.path) ? next() : c.json({ error: 'login' }, 401));
  app.route('/api/public/news', createPublicNewsRouter({ repository: () => fakeRepository as never, getClientId: () => 'test' }));
  assert.equal((await app.request('/api/public/news')).status, 401);
  assert.equal((await app.request('/api/public/news', { headers: { 'x-relay-token': 'internal' } })).status, 200);
  assert.equal((await app.request('/api/news', { headers: { 'x-relay-token': 'internal' } })).status, 401);
});

let lastOptions: Record<string, unknown> = {};
const fakeRepository = {
  getStatus: () => ({ available: true, version: 3, lastSuccessAt: 123, error: null }),
  async list(options: Record<string, unknown>) {
    lastOptions = options;
    return { items: [], nextCursor: null, version: 3 };
  },
  getSourceState: () => null,
};

test('public feed validates bounds and returns only public data', async () => {
  const router = createPublicNewsRouter({ repository: () => fakeRepository as never, now: () => 2_000_000_000_000, getClientId: () => 'test-2' });
  const response = await router.request('/?category=model&topic=llm&entity=openai&eventType=release&source=openai&language=en&q=hello');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.items.length, 0);
  assert.equal(lastOptions.limit, 20);
  assert.equal((lastOptions.filters as Record<string, string>).source, 'openai');
  assert.equal((lastOptions.filters as Record<string, string>).topic, undefined);
  assert.equal(data.version, 3);
  assert.equal(data.lastSuccessAt, 123);
  assert.equal(data.partialFailure, false);
  assert.equal(JSON.stringify(data).includes('options'), false);
  for (const query of ['limit=51', 'q=' + 'x'.repeat(121), 'cursor=bad', 'from=1&to=2000000000000']) {
    assert.equal((await router.request(`/?${query}`)).status, 400, query);
  }
  const version = await (await router.request('/version')).json();
  assert.deepEqual(Object.keys(version).sort(), ['lastSuccessAt', 'partialFailure', 'version']);
});

test('国内与海外筛选按来源地区生成有界来源集合', async () => {
  const repo = { ...fakeRepository, listSources: () => [
    { id: 'cn-feed', name: '中文源', region: 'cn', enabled: true },
    { id: 'world-feed', name: '海外源', region: 'global', enabled: true },
  ] };
  const router = createPublicNewsRouter({ repository: () => repo as never, now: () => 2_000_000_000_000, getClientId: () => 'region-test' });
  assert.equal((await router.request('/?region=cn')).status, 200);
  assert.deepEqual((lastOptions.filters as { sourceIds?: string[] }).sourceIds, ['cn-feed', 'social-wechat', 'social-xiaohongshu', 'social-douyin', 'social-kuaishou', 'social-weibo']);
  assert.equal((await router.request('/?region=unknown')).status, 400);
});

test('global rules hide historical sources immediately while retaining other event sources', async () => {
  const first = { id: 'a', eventId: 'event', sourceId: 'blocked', url: 'https://blocked.example/post', title: 'AI release', description: null, publishedAt: 1_999_999_999_000, firstFetchedAt: 1_999_999_999_000, categoryId: 'research', topicIds: [], entityIds: [], eventTypeId: 'release', language: 'en' };
  const second = { ...first, id: 'b', sourceId: 'safe', url: 'https://safe.example/post' };
  let blocked = ['blocked.example'];
  const repo = {
    ...fakeRepository,
    getStatus: () => ({ available: true, version: blocked.length + 2, lastSuccessAt: 123, error: null }),
    getGlobalPolicy: () => ({ blockedDomains: blocked, blockedKeywords: [], blockedUrls: [] }),
    getCorrection: () => null,
    list: async () => ({ items: [{ ...first, sources: [first, second] }], nextCursor: null, version: 3 }),
  };
  const router = createPublicNewsRouter({ repository: () => repo as never, now: () => 2_000_000_000_000, getClientId: () => 'policy-test' });
  let body = await (await router.request('/')).json();
  assert.equal(body.items.length, 1);
  assert.deepEqual(body.items[0].sources.map((entry: { sourceId: string }) => entry.sourceId), ['safe']);
  assert.equal(JSON.stringify(body).includes('blocked.example'), false);
  blocked = ['blocked.example', 'safe.example'];
  body = await (await router.request('/')).json();
  assert.equal(body.items.length, 0);
});
