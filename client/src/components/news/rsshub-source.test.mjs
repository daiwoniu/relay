import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRsshubSource } from './rsshub-source.ts';

test('管理员可按账号或热搜建立定时 RSSHub 来源', () => {
  const hot = buildRsshubSource('http://127.0.0.1:1200', 'weibo-hot', '', '', 60);
  assert.equal(hot.url, 'http://127.0.0.1:1200/weibo/search/hot');
  assert.deepEqual(hot.allowedHosts, ['127.0.0.1']);
  assert.equal(hot.enabled, true);
  const account = buildRsshubSource('https://rss.example.com', 'xiaohongshu-user', '593032945e87e77791e03696', '测试账号', 120);
  assert.equal(account.url, 'https://rss.example.com/xiaohongshu/user/593032945e87e77791e03696/notes');
  assert.match(account.name, /测试账号/);
});

test('RSSHub 来源生成拒绝任意本机服务和无效账号', () => {
  assert.throws(() => buildRsshubSource('http://127.0.0.1:9181', 'weibo-hot', '', '', 60), /RSSHub 地址/);
  assert.throws(() => buildRsshubSource('https://rss.example.com', 'douyin-user', '../admin', '', 60), /账号 ID/);
});
