import assert from 'node:assert/strict';
import test from 'node:test';
import { collectWechat, parseKuaishou, parseWechat } from './sources.mjs';

const searchPage = 'https://www.sogou.com/iweixin?tab=weixin_vertical&query=Agent';

function wechatCard(title, id) {
  return `<div hidden><article class="result-card">
    <a href="http://mp.weixin.qq.com/s/${id}?src=11&amp;ver=1" data-log="{&quot;linkid&quot;:&quot;title&quot;}">${title}</a>
    <a href="http://mp.weixin.qq.com/s/${id}" data-log="{&quot;linkid&quot;:&quot;summary&quot;}"><p>摘要 &amp; 正文简介。</p></a>
    <a href="http://mp.weixin.qq.com/s/${id}" data-log="{&quot;linkid&quot;:&quot;metainfo&quot;}"><span>示例公众号</span><span>2026-11-23</span></a>
  </article></div>`;
}

test('搜狗当前文章卡片可提取直链、日期、摘要及高亮标题', () => {
  assert.deepEqual(parseWechat(wechatCard('<em>AI</em> Agent', 'demo'), searchPage), [{
    title: 'AI Agent', author: '示例公众号', summary: '摘要 & 正文简介。', publishedAt: null,
    publishedLabel: '2026-11-23', url: 'https://mp.weixin.qq.com/s/demo?src=11&ver=1',
  }]);
});

test('搜狗旧版文章提取原时间戳并保留转跳链接', () => {
  const html = `<ul class="news-list"><li><h3><a href="/link?url=article">旧版结果</a></h3>
    <p class="txt-info">文章摘要</p><span class="all-time-y2">示例公众号</span>
    <script>document.write(timeConvert('1795312822'))</script></li></ul>`;
  const [row] = parseWechat(html, 'https://weixin.sogou.com/weixin?type=2');
  assert.equal(row.url, 'https://weixin.sogou.com/link?url=article');
  assert.equal(row.publishedAt, new Date(1795312822 * 1000).toISOString());
});

test('验证码、缺失响应和真实空结果使用不同状态', () => {
  assert.throws(() => parseWechat('<p>验证码用于确认这些请求是您的正常行为</p>', searchPage), { status: 'access_restricted' });
  assert.throws(() => parseWechat('', searchPage), { status: 'source_unavailable' });
  assert.deepEqual(parseWechat('<p>未找到相关结果</p>', searchPage), []);
  assert.throws(() => parseKuaishou({ data: { result: 400002 } }), { status: 'access_restricted' });
  assert.throws(() => parseKuaishou({ result: 2 }), { status: 'source_unavailable' });
});

test('公众号跟随页面给出的下一页，遇验证时保留已取得结果', async (t) => {
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetched.push(url.href);
    return { ok: true, url: url.href, text: async () => fetched.length === 1
      ? `${wechatCard('首条', 'one')}<a href="/iweixin?tab=weixin_vertical&amp;query=Agent&amp;page=2">下一页</a>`
      : '<p>请输入验证码</p>' };
  });
  const result = await collectWechat('Agent', 2);
  assert.equal(fetched.length, 2);
  assert.equal(new URL(fetched[1]).searchParams.get('page'), '2');
  assert.equal(result.items.length, 1);
  assert.equal(result.fetchedPages, 1);
  assert.equal(result.incomplete, true);
});

test('快手首批数据过滤非作品、去重并报告分页游标', () => {
  const feed = { photo: { id: '3xexample', caption: '作品标题', timestamp: 1795312822000, likeCount: '1.2万', duration: 58066 },
    author: { name: '示例作者' } };
  const result = parseKuaishou({ result: 1, feeds: [null, feed, feed], pcursor: '1' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].likes, 12000);
  assert.equal(result.items[0].durationMs, 58066);
  assert.equal(result.items[0].url, 'https://www.kuaishou.com/short-video/3xexample');
  assert.deepEqual(result.pagination, { cursor: '1', fetchedBatches: 1 });
});
