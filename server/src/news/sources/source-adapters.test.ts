import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGithubReleases } from './github-releases.js';
import { parseHackerNewsItem } from './hacker-news.js';

test('GitHub Release 映射标题、链接、时间并截断到 100 条', () => {
  const releases = Array.from({ length: 101 }, (_, index) => ({
    html_url: `https://github.com/org/repo/releases/tag/v${index}`,
    name: `Version ${index}`, tag_name: `v${index}`, body: 'Changes', published_at: '2026-10-15T10:00:00Z', draft: false,
  }));
  const candidates = parseGithubReleases(JSON.stringify(releases), 'github-repo', 'https://api.github.com/repos/org/repo/releases');
  assert.equal(candidates.length, 100);
  assert.equal(candidates[0]?.title, 'Version 0');
  assert.equal(candidates[0]?.rawPublishedAt, '2026-10-15T10:00:00Z');
});

test('双语官方发布优先提取中文说明，保留原帖链接', () => {
  const body = `## English Version\n${'English changes. '.repeat(90)}\n## 中文版\n新增多轮模型评测，改进中文数据集支持。`;
  const [release] = parseGithubReleases(JSON.stringify([{
    html_url: 'https://github.com/modelscope/evalscope/releases/tag/v1.13.0',
    name: 'v1.13.0', body, published_at: '2026-10-13T10:00:00Z',
  }]), 'modelscope-evalscope-releases', 'https://api.github.com/repos/modelscope/evalscope/releases');
  assert.match(release?.description ?? '', /新增多轮模型评测/);
  assert.doesNotMatch(release?.description ?? '', /English changes/);
  assert.equal(release?.rawUrl, 'https://github.com/modelscope/evalscope/releases/tag/v1.13.0');
});

test('HN 仅将有效 story 映射为候选', () => {
  const story = parseHackerNewsItem({ id: 1, type: 'story', title: 'AI release', url: 'https://example.org/post', time: 1_760_000_000 }, 'hacker-news');
  assert.equal(story?.rawUrl, 'https://example.org/post');
  assert.equal(story?.rawPublishedAt, 1_760_000_000);
  assert.equal(parseHackerNewsItem({ id: 2, type: 'comment', text: 'hello' }, 'hacker-news'), null);
});
