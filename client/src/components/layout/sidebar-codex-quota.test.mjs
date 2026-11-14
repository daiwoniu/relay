import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSidebarCodexQuota } from './sidebar-codex-quota.ts';

const limit = (windowType, windowDurationMins, usedPercent, limitId = 'codex') => ({
  limitId, limitName: null, windowType, usedPercent, windowDurationMins,
  resetsAt: 1_800_000_000, normalModelSlug: null, rateLimitReachedType: null,
  spendControlReached: false,
});
const snapshot = (rateLimits, authMode = 'chatgpt') => ({
  status: 'ready', authMode, rateLimits,
});

test('侧边栏只展示 Codex 实际返回的窗口，并以剩余比例填充', () => {
  const quota = selectSidebarCodexQuota(snapshot([
    limit('secondary', 10080, 58), limit('primary', 300, 32.4),
    limit('primary', 300, 10, 'gpt-reserve'),
  ]), 1_800_000_000_000 - (3 * 24 + 4) * 3_600_000);
  assert.deepEqual(quota.map(({ label, remaining }) => ({ label, remaining })), [
    { label: '5h', remaining: 68 }, { label: '4天', remaining: 42 },
  ]);
  assert.match(quota[0].reset, /下次重置/);
});

test('长周期窗口不足一天时改用剩余小时，缺少重置时间时保留窗口时长', () => {
  const weekly = snapshot([limit('secondary', 10080, 58)]);
  assert.equal(selectSidebarCodexQuota(weekly, 1_800_000_000_000 - 6 * 3_600_000)[0].label, '6h');
  weekly.rateLimits[0].resetsAt = null;
  assert.equal(selectSidebarCodexQuota(weekly)[0].label, '7天');
});

test('API Key 模式和未提供 Codex 窗口时不显示虚假额度', () => {
  assert.deepEqual(selectSidebarCodexQuota(snapshot([limit('primary', 300, 10)], 'apikey')), []);
  assert.deepEqual(selectSidebarCodexQuota(snapshot([limit('primary', 300, 10, 'gpt-reserve')])), []);
});
