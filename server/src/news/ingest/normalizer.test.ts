import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandidate, isLikelyAi } from './normalizer.js';
import type { NewsSource } from '../sources/source-types.js';

const source: NewsSource = { id: 'source-a', name: 'AI Feed', kind: 'rss_atom', url: 'https://example.org/feed', allowedHosts: ['example.org'], enabled: true, intervalMinutes: 30, categoryId: 'industry' };

test('相对链接标准化并去掉跟踪参数，形成稳定去重 ID', () => {
  const now = Date.parse('2026-10-15T10:00:00Z');
  const common = { sourceId: source.id, baseUrl: source.url, title: 'New AI agent', description: null, rawPublishedAt: '2026-10-15T09:00:00Z' };
  const first = normalizeCandidate({ ...common, rawUrl: '/post?id=1&utm_source=rss' }, source, now);
  const second = normalizeCandidate({ ...common, rawUrl: 'https://example.org/post?utm_medium=email&id=1' }, source, now);
  assert.equal(first.url, 'https://example.org/post?id=1');
  assert.equal(first.id, second.id);
  const reportedByOtherSource = normalizeCandidate({ ...common, sourceId: 'source-b', rawUrl: '/post?id=1' }, { ...source, id: 'source-b' }, now);
  assert.notEqual(first.id, reportedByOtherSource.id);
  assert.equal(first.eventId, reportedByOtherSource.eventId);
  assert.equal(first.categoryId, 'industry');
  assert.ok(first.topicIds.includes('agent'));
});

test('缺失和明显错误的发布时间回退首次抓取时间并标记', () => {
  const now = Date.parse('2026-10-15T10:00:00Z');
  for (const rawPublishedAt of [null, '1900-01-01', '2035-01-01']) {
    const result = normalizeCandidate({ sourceId: source.id, baseUrl: source.url, rawUrl: '/post', title: 'AI paper', description: null, rawPublishedAt }, source, now);
    assert.equal(result.publishedAt, now);
    assert.equal(result.timeIsFallback, true);
  }
});

test('社区来源仅丢弃明显无关内容，未知但有 AI 线索保留', () => {
  const community: NewsSource = { ...source, kind: 'hacker_news' };
  assert.equal(isLikelyAi({ sourceId: source.id, baseUrl: source.url, rawUrl: '/a', title: 'Claude agent update', description: null, rawPublishedAt: null }, community), true);
  assert.equal(isLikelyAi({ sourceId: source.id, baseUrl: source.url, rawUrl: '/b', title: 'A new bicycle route', description: null, rawPublishedAt: null }, community), false);
});

test('国内模型品牌报道可采集并标注主体', () => {
  const now = Date.parse('2026-10-16T10:00:00Z');
  const candidate = { sourceId: source.id, baseUrl: source.url, rawUrl: '/kimi-update', title: 'Kimi 新版本上线', description: null, rawPublishedAt: now };
  assert.equal(isLikelyAi(candidate, source), true);
  const normalized = normalizeCandidate(candidate, source, now);
  assert.deepEqual(normalized.entityIds, ['kimi']);
  assert.equal(normalized.eventTypeId, 'update');
});

test('英文版本号附中文官方说明仍标记为中文可读', () => {
  const now = Date.parse('2026-10-16T10:00:00Z');
  const normalized = normalizeCandidate({
    sourceId: source.id, baseUrl: source.url, rawUrl: '/release', title: 'v1.13.0',
    description: '新增多轮模型评测，改进中文数据集支持，优化推理性能和多模态基准测试。', rawPublishedAt: now,
  }, source, now);
  assert.equal(normalized.language, 'zh');
});
