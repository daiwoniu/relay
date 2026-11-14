import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCodexAccountEmail, formatCodexFetchedAt, formatCodexLimitWindow, formatCodexPlanType, formatCodexRateLimitReason, formatCodexResetTime, formatCodexTokenCount, getCodexAccountStatusLabel, sortCodexUsageBucketsNewestFirst } from './codex-account-presentation.ts';

test('Codex account presentation masks email and formats reset time', () => {
  assert.equal(formatCodexAccountEmail('user@example.com'), 'use***@example.com');
  assert.equal(formatCodexAccountEmail(null), '未显示邮箱');
  assert.match(formatCodexResetTime(1_800_000_000), /^下次重置：\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatCodexPlanType('pro'), 'Pro');
  assert.match(formatCodexFetchedAt(1_800_000_000_000), /^读取于 \d{2}:\d{2}:\d{2}$/);
});

test('Codex account presentation distinguishes unavailable and API key modes', () => {
  assert.equal(getCodexAccountStatusLabel({ status: 'unavailable', authMode: 'unknown' }), '额度暂时不可用');
  assert.equal(getCodexAccountStatusLabel({ status: 'ready', authMode: 'apikey' }), 'API Key 计费');
  assert.equal(getCodexAccountStatusLabel({ status: 'ready', authMode: 'chatgpt' }), '官方账号已连接');
});

test('Codex account presentation labels windows by official duration', () => {
  assert.equal(formatCodexLimitWindow({ windowType: 'secondary', windowDurationMins: 300 }), '5 小时窗口');
  assert.equal(formatCodexLimitWindow({ windowType: 'primary', windowDurationMins: 10080 }), '7 天窗口');
  assert.equal(formatCodexLimitWindow({ windowType: 'primary', windowDurationMins: null }), '主窗口');
});

test('Codex account presentation explains rate limit state without inventing one', () => {
  assert.equal(formatCodexRateLimitReason({ rateLimitReachedType: 'RateLimitReached', spendControlReached: false }), '已触发限额');
  assert.equal(formatCodexRateLimitReason({ rateLimitReachedType: null, spendControlReached: true }), '消费控制已触发');
  assert.equal(formatCodexRateLimitReason({ rateLimitReachedType: null, spendControlReached: false }), null);
});

test('Codex token counts use readable Chinese units', () => {
  assert.equal(formatCodexTokenCount(47_867_256_395), '478.7亿');
  assert.equal(formatCodexTokenCount(1_234_567), '123.5万');
  assert.equal(formatCodexTokenCount(1234), '1,234');
  assert.equal(formatCodexTokenCount(null), '未提供');
});

test('Codex daily usage is ordered newest first without mutating the response', () => {
  const buckets = [
    { startDate: '2026-09-21', tokens: 10 },
    { startDate: '2026-09-23', tokens: 30 },
    { startDate: '2026-09-22', tokens: 20 },
  ];
  assert.deepEqual(sortCodexUsageBucketsNewestFirst(buckets).map((bucket) => bucket.startDate), ['2026-09-23', '2026-09-22', '2026-09-21']);
  assert.deepEqual(buckets.map((bucket) => bucket.startDate), ['2026-09-21', '2026-09-23', '2026-09-22']);
});
