import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSource } from './fetch-source.js';
import type { NewsSource } from './source-types.js';
import type { RawResponse } from './safe-fetch.js';

const rssSource: NewsSource = {
  id: 'example', name: 'Example', kind: 'rss_atom', url: 'https://example.org/feed.xml',
  allowedHosts: ['example.org'], enabled: true, intervalMinutes: 30, categoryId: 'industry',
};

function raw(status: number, body = '', headers: Record<string, string | null> = {}): RawResponse {
  return { status, body: Buffer.from(body), headers: { etag: null, 'last-modified': null, 'retry-after': null, location: null, ...headers } };
}

test('RSS 条件请求 304 不生成候选并保留缓存头', async () => {
  const result = await fetchSource(rssSource, { signal: new AbortController().signal, etag: 'old' }, {
    fetch: async (_url, options) => { assert.equal(options.etag, 'old'); return raw(304, '', { etag: 'new' }); },
  });
  assert.equal(result.status, 'not_modified');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.etag, 'new');
});

test('GitHub 429 提供可退避状态且不解析正文', async () => {
  const source: NewsSource = { ...rssSource, kind: 'github_releases', url: 'https://api.github.com/repos/org/repo/releases', allowedHosts: ['api.github.com'] };
  const result = await fetchSource(source, { signal: new AbortController().signal }, { fetch: async () => raw(429, 'error', { 'retry-after': '60' }) });
  assert.equal(result.status, 'rate_limited');
  assert.equal(result.retryAfterMs, 60_000);
  assert.deepEqual(result.candidates, []);
});

test('HN 新故事只读取有界详情并映射候选', async () => {
  const source: NewsSource = { ...rssSource, kind: 'hacker_news', url: 'https://hacker-news.firebaseio.com/v0/newstories.json', allowedHosts: ['hacker-news.firebaseio.com'] };
  const visited: string[] = [];
  const result = await fetchSource(source, { signal: new AbortController().signal }, { fetch: async (url) => {
    visited.push(url);
    if (url.endsWith('newstories.json')) return raw(200, JSON.stringify(Array.from({ length: 50 }, (_, i) => i + 1)));
    const id = Number(url.match(/item\/(\d+)/)?.[1]);
    return raw(200, JSON.stringify({ id, type: 'story', title: `AI ${id}`, time: 1_760_000_000, url: `https://example.org/${id}` }));
  } });
  assert.equal(result.status, 'ok');
  assert.equal(result.candidates.length, 20);
  assert.equal(visited.length, 21);
});

test('HN 详情全部失败时不把来源标记为成功', async () => {
  const source: NewsSource = { ...rssSource, kind: 'hacker_news', url: 'https://hacker-news.firebaseio.com/v0/newstories.json', allowedHosts: ['hacker-news.firebaseio.com'] };
  const result = await fetchSource(source, { signal: new AbortController().signal }, { fetch: async (url) => {
    if (url.endsWith('newstories.json')) return raw(200, '[1,2]');
    throw new Error('detail timeout');
  } });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.candidates, []);
});
