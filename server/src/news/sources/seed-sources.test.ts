import test from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_DISABLED_SEED_SOURCES, SEED_SOURCES } from './seed-sources.js';

test('种子清单只包含可采集来源且覆盖多类来源', () => {
  assert.ok(SEED_SOURCES.length >= 12);
  assert.equal(new Set(SEED_SOURCES.map((source) => source.id)).size, SEED_SOURCES.length);
  assert.ok(SEED_SOURCES.some((source) => source.kind === 'rss_atom' && source.enabled));
  assert.ok(SEED_SOURCES.some((source) => source.kind === 'github_releases' && source.enabled));
  assert.ok(SEED_SOURCES.some((source) => source.kind === 'hacker_news' && source.enabled));
  for (const source of SEED_SOURCES) {
    assert.equal(new URL(source.url).protocol, 'https:');
    assert.ok(source.allowedHosts.includes(new URL(source.url).hostname));
    assert.equal(source.enabled, true);
  }
  assert.equal(LEGACY_DISABLED_SEED_SOURCES.length, 5);
  assert.ok(LEGACY_DISABLED_SEED_SOURCES.every((source) => !source.enabled && Boolean(source.disabledReason)));
  assert.equal(SEED_SOURCES.find((source) => source.id === 'arxiv-cs-lg-rss')?.enabled, true);
  for (const old of LEGACY_DISABLED_SEED_SOURCES) {
    if (old.id !== 'arxiv-cs-lg-rss') assert.equal(SEED_SOURCES.some((source) => source.id === old.id), false);
  }
});

test('国内来源同时覆盖中文科技媒体与确有发布记录的模型团队', () => {
  const ithome = SEED_SOURCES.find((source) => source.id === 'ithome-rss');
  const deepseek = SEED_SOURCES.find((source) => source.id === 'deepseek-v3-releases');
  const internlm = SEED_SOURCES.find((source) => source.id === 'internlm-releases');
  assert.equal(ithome?.enabled, true);
  assert.equal(ithome?.url, 'https://www.ithome.com/rss/');
  assert.equal(ithome?.region, 'cn');
  assert.equal(deepseek?.enabled, true);
  assert.equal(deepseek?.kind, 'github_releases');
  assert.equal(internlm?.enabled, true);
  assert.equal(internlm?.kind, 'github_releases');
  assert.equal(SEED_SOURCES.find((source) => source.id === 'modelscope-swift-releases')?.region, 'cn');
  assert.equal(SEED_SOURCES.find((source) => source.id === 'modelscope-evalscope-releases')?.region, 'cn');
  assert.equal(SEED_SOURCES.some((source) => source.url === 'https://www.qbitai.com/feed' && source.enabled), false);
});

test('近期可采集的国内中文媒体订阅源已启用并标记为国内', () => {
  const feeds = new Map([
    ['aiera-rss', 'https://aiera.com.cn/feed/'],
    ['ifanr-rss', 'https://www.ifanr.com/feed'],
    ['tmtpost-rss', 'https://www.tmtpost.com/rss.xml'],
  ]);
  for (const [id, url] of feeds) {
    const source = SEED_SOURCES.find((entry) => entry.id === id);
    assert.equal(source?.url, url);
    assert.equal(source?.kind, 'rss_atom');
    assert.equal(source?.enabled, true);
    assert.equal(source?.region, 'cn');
    assert.deepEqual(source?.allowedHosts, [new URL(url).hostname]);
  }
});
