import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRssAtom } from './rss-atom.js';

test('RSS 条目保留原始时间并安全转成纯文本描述', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>AI &amp; Tools</title><link>/news/1</link><pubDate>Thu, 15 Oct 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Useful <b>release</b></p><script>alert(1)</script>]]></description></item></channel></rss>`;
  const candidates = parseRssAtom(xml, 'source-a', 'https://example.org/feed.xml');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.rawUrl, '/news/1');
  assert.equal(candidates[0]?.baseUrl, 'https://example.org/feed.xml');
  assert.equal(candidates[0]?.rawPublishedAt, 'Thu, 15 Oct 2026 10:00:00 GMT');
  assert.equal(candidates[0]?.title, 'AI & Tools');
  assert.equal(candidates[0]?.description, 'Useful release');
});

test('Atom link href 与 published 可解析，畸形 XML 拒绝', () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Model update</title><link rel="alternate" href="https://example.org/post"/><published>2026-10-15T10:00:00Z</published><summary>New model</summary></entry></feed>`;
  const candidates = parseRssAtom(xml, 'source-a', 'https://example.org/atom');
  assert.deepEqual(candidates.map((item) => [item.rawUrl, item.rawPublishedAt]), [['https://example.org/post', '2026-10-15T10:00:00Z']]);
  assert.throws(() => parseRssAtom('<rss><item>', 'source-a', 'https://example.org/feed'), /XML|closed|unclosed|tag/i);
});
