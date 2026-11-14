import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalRsshubUrl } from './rsshub-local.js';
import { validateSourceConfig } from '../policy/global-policy.js';
import { fetchSource } from './fetch-source.js';

const url = 'http://127.0.0.1:1200/weibo/search/hot';
const source = { id: 'rsshub-weibo-hot', name: '微博热搜', kind: 'rss_atom' as const, url, allowedHosts: ['127.0.0.1'], enabled: true, intervalMinutes: 60, categoryId: 'industry', region: 'cn' as const };

test('本机 RSSHub 仅允许固定端口和已知订阅路由', () => {
  assert.deepEqual(validateSourceConfig(source), source);
  for (const target of ['http://127.0.0.1:9181/api/health', 'http://localhost:1200/weibo/search/hot',
    'http://127.0.0.1:1200/admin', 'http://127.0.0.1:1200/weibo/search/hot?x=1']) {
    assert.equal(isLocalRsshubUrl(target), false);
    assert.throws(() => validateSourceConfig({ ...source, url: target }), /公开 HTTPS/);
  }
  assert.throws(() => validateSourceConfig({ ...source, allowedHosts: ['127.0.0.1', 'other.example'] }), /RSSHub 本机/);
});

test('本机 RSSHub 经 RSS 解析后进入现有采集模型', async () => {
  const result = await fetchSource(source, { signal: AbortSignal.timeout(1000) }, {
    fetch: async () => { throw new Error('不应走公网抓取器'); },
    fetchLocal: async () => ({ status: 200, headers: { etag: null, 'last-modified': null }, body: Buffer.from('<rss><channel><item><title>AI 模型发布</title><link>https://weibo.com/123/abc</link><author>模型作者</author><pubDate>Wed, 21 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>') }),
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.candidates[0]?.rawUrl, 'https://weibo.com/123/abc');
  assert.equal(result.candidates[0]?.originalPublisher, '模型作者');
});
