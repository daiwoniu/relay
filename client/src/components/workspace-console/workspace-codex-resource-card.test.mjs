import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCodexResetTitle, formatCodexTaskDuration, projectTokenActivityDays, projectTokenCalendarLayout, projectWorkspaceCodexResource } from './workspace-codex-resource.ts';
import * as resource from './workspace-codex-resource.ts';

test('local daily buckets feed the same daily, weekly, cumulative and bar projections', () => {
  assert.equal(typeof resource.projectLocalTokenActivityDays, 'function');
  const days = resource.projectLocalTokenActivityDays([
    { startDate: '2026-09-28', tokens: 10 },
    { startDate: '2026-09-29', tokens: 20 },
    { startDate: '2026-10-05', tokens: 5 },
  ]);
  assert.deepEqual(days.map((day) => [day.date, day.tokens]), [
    ['2026-09-28', 10], ['2026-09-29', 20], ['2026-10-05', 5],
  ]);
  assert.deepEqual(resource.projectTokenActivityDays(days, 'daily').map((day) => day.value), [10, 20, 5]);
  assert.deepEqual(resource.projectTokenActivityDays(days, 'weekly').map((day) => day.value), [30, 30, 5]);
  assert.deepEqual(resource.projectTokenActivityDays(days, 'cumulative').map((day) => day.value), [10, 30, 35]);
  assert.equal(resource.projectTokenActivityBars(resource.projectTokenActivityDays(days, 'weekly'), 'weekly').length, 2);
});

test('Token activity source selection uses official or local buckets', () => {
  assert.equal(typeof resource.selectTokenActivityInputDays, 'function');
  const official = [{ date: '2026-09-29', tokens: 99, level: 4 }];
  const local = [{ startDate: '2026-09-29', tokens: 12 }];
  assert.deepEqual(resource.selectTokenActivityInputDays('official', official, local, '2026-09-29'), official);
  assert.deepEqual(resource.selectTokenActivityInputDays('local', official, local, '2026-09-29').map((day) => day.tokens), [12]);
});

test('official Token activity includes today as zero until the official bucket arrives', () => {
  const official = [
    { date: '2026-09-28', tokens: 20, level: 2 },
    { date: '2026-09-29', tokens: 30, level: 3 },
  ];
  const local = [{ startDate: '2026-09-30', tokens: 12 }];
  const days = resource.selectTokenActivityInputDays('official', official, local, '2026-09-30');
  assert.equal(days.length, 365);
  assert.deepEqual(days.slice(-4).map(({ date, tokens }) => [date, tokens]), [
    ['2026-09-27', null], ['2026-09-28', 20], ['2026-09-29', 30], ['2026-09-30', 0],
  ]);
  assert.deepEqual(resource.projectTokenActivityDays(days, 'daily').slice(-3).map(({ value }) => value), [20, 30, 0]);
  assert.equal(resource.projectTokenActivityDays(days, 'cumulative').at(-1).value, 50);
  assert.equal(resource.selectTokenActivityInputDays('local', official, local, '2026-09-30').at(-1).date, '2026-09-30');

  const updated = resource.selectTokenActivityInputDays('official', [...official, { date: '2026-09-30', tokens: 40, level: 4 }], local, '2026-09-30');
  assert.equal(updated.at(-1).tokens, 40);
});

test('local summary derives the five official-style values and preserves zero days', () => {
  assert.equal(typeof resource.projectLocalTokenActivitySummary, 'function');
  const days = resource.projectLocalTokenActivityDays([
    { startDate: '2026-09-25', tokens: 0 },
    { startDate: '2026-09-26', tokens: 10 },
    { startDate: '2026-09-27', tokens: 20 },
    { startDate: '2026-09-28', tokens: 0 },
    { startDate: '2026-09-29', tokens: 5 },
  ]);
  assert.deepEqual(resource.projectLocalTokenActivitySummary(days), {
    lifetimeTokens: 35, peakDailyTokens: 20, longestRunningTurnSec: 0,
    currentStreakDays: 1, longestStreakDays: 2,
  });
  assert.deepEqual(resource.projectLocalTokenActivitySummary(days.map((day) => ({ ...day, tokens: 0 }))), {
    lifetimeTokens: 0, peakDailyTokens: 0, longestRunningTurnSec: 0,
    currentStreakDays: 0, longestStreakDays: 0,
  });
  assert.deepEqual(resource.projectTokenActivityDays(days, 'daily').map((day) => day.value), [0, 10, 20, 0, 5]);
});

test('official reset and task duration values have readable Chinese labels', () => {
  assert.equal(formatCodexResetTitle('Full reset', 0), '完全重置');
  assert.equal(formatCodexResetTitle('full_reset', 0), '完全重置');
  assert.equal(formatCodexResetTitle(null, 1), '重置额度 2');
  assert.equal(formatCodexTaskDuration(3661), '1 小时 1 分 1 秒');
  assert.equal(formatCodexTaskDuration(null), '未提供');
});

test('missing quota windows stay unknown and email remains masked', () => {
  const view = projectWorkspaceCodexResource({ status: 'ready', authMode: 'chatgpt', email: 'user@example.com', planType: 'plus', rateLimits: [], fetchedAt: 1_000, credits: null, usage: null, rateLimitResetCredits: null, errorMessage: null }, false);
  assert.equal(view.email, 'use***@example.com');
  assert.equal(view.primaryWindow, '未提供');
  assert.deepEqual(view.windows, []);
  assert.deepEqual(view.summaryWindows, []);
  assert.deepEqual(view.usageDays, []);
  assert.equal(view.manualResets, null);
  assert.equal(view.stale, false);
});

test('API Key mode and stale snapshots are labelled without a false zero balance', () => {
  const view = projectWorkspaceCodexResource({ status: 'ready', authMode: 'apikey', email: null, planType: null, rateLimits: [], fetchedAt: 1_000, credits: null, usage: null, rateLimitResetCredits: null, errorMessage: null }, true);
  assert.match(view.status, /API Key/);
  assert.equal(view.stale, true);
  assert.equal(view.primaryWindow, '未提供');
});

test('returned quota windows keep their actual duration, reset time and remaining percentage', () => {
  const view = projectWorkspaceCodexResource({ status: 'ready', authMode: 'chatgpt', email: null, planType: 'pro', fetchedAt: 1_000,
    rateLimits: [{ limitId: 'codex', limitName: null, windowType: 'primary', usedPercent: 37.6, windowDurationMins: 120,
      resetsAt: 1_800_000_000, normalModelSlug: null, rateLimitReachedType: null, spendControlReached: false }],
    credits: { remaining: 12, currency: 'USD', hasCredits: true, unlimited: false }, usage: null, rateLimitResetCredits: null, errorMessage: null }, false);
  assert.equal(view.windows[0].window, '120 分钟窗口');
  assert.equal(view.windows[0].remaining, 62);
  assert.match(view.windows[0].reset, /下次重置/);
  assert.equal(view.windows[0].startAt, 1_799_992_800);
  assert.equal(view.credits.remaining, 12);
  assert.equal(view.hasFiveHourWindow, false);
});

test('weekly-only response keeps reset time and available manual resets without inventing a five-hour window', () => {
  const view = projectWorkspaceCodexResource({ status: 'ready', authMode: 'chatgpt', email: null, planType: 'plus', fetchedAt: 1_000,
    rateLimits: [{ limitId: 'codex', limitName: null, windowType: 'primary', usedPercent: 23, windowDurationMins: 10080,
      resetsAt: 1_791_070_437, normalModelSlug: null, rateLimitReachedType: null, spendControlReached: false }],
    credits: null, usage: null, rateLimitResetCredits: { availableCount: 3 }, errorMessage: null }, false);
  assert.equal(view.summaryWindows[0].window, '7 天窗口');
  assert.match(view.summaryWindows[0].reset, /下次重置/);
  assert.equal(view.summaryWindows[0].startAt, 1_790_465_637);
  assert.equal(view.manualResets, 3);
  assert.equal(view.hasFiveHourWindow, false);
});

test('quota window start stays unknown without both a reset time and duration', () => {
  const base = { limitId: 'codex', limitName: null, windowType: 'primary', usedPercent: 20,
    normalModelSlug: null, rateLimitReachedType: null, spendControlReached: false };
  const view = projectWorkspaceCodexResource({ status: 'ready', authMode: 'chatgpt', email: null, planType: 'plus', fetchedAt: 1_000,
    rateLimits: [{ ...base, windowDurationMins: null, resetsAt: 1_800_000_000 }, { ...base, windowType: 'secondary', windowDurationMins: 300, resetsAt: null }],
    credits: null, usage: null, rateLimitResetCredits: null, errorMessage: null }, false);
  assert.deepEqual(view.windows.map((window) => window.startAt), [null, null]);
});

test('manual reset details keep each available expiry and leave count-only snapshots undated', () => {
  const base = { status: 'ready', authMode: 'chatgpt', email: null, planType: 'pro', fetchedAt: 1_000,
    rateLimits: [], credits: null, usage: null, errorMessage: null };
  const detailed = projectWorkspaceCodexResource({ ...base, rateLimitResetCredits: { availableCount: 3, credits: [
    { id: 'credit-1', title: '完全重置', expiresAt: 1_800_000_000 }, { id: 'credit-2', title: '完全重置', expiresAt: 1_800_086_400 },
    { id: null, title: null, expiresAt: null },
  ] } }, false);
  assert.deepEqual(detailed.manualResetCredits.map(({ id, title, expiresAt }) => [id, title, expiresAt]), [
    ['credit-1', '完全重置', 1_800_000_000], ['credit-2', '完全重置', 1_800_086_400], [null, null, null],
  ]);
  const countOnly = projectWorkspaceCodexResource({ ...base, rateLimitResetCredits: { availableCount: 3 } }, false);
  assert.equal(countOnly.manualResets, 3);
  assert.deepEqual(countOnly.manualResetCredits, []);
});

test('compact quota bars use the same limit and put its short window first', () => {
  const limit = (limitId, windowType, windowDurationMins, usedPercent) => ({
    limitId, limitName: null, windowType, windowDurationMins, usedPercent,
    resetsAt: null, normalModelSlug: null, rateLimitReachedType: null, spendControlReached: false,
  });
  const view = projectWorkspaceCodexResource({
    status: 'ready', authMode: 'chatgpt', email: null, planType: 'plus', fetchedAt: 1_000,
    rateLimits: [limit('codex', 'secondary', 10080, 80), limit('gpt-reserve', 'primary', 300, 10), limit('codex', 'primary', 300, 35)],
    credits: null, usage: null, rateLimitResetCredits: null, errorMessage: null,
  }, false);
  assert.deepEqual(view.summaryWindows.map(({ window, remaining }) => [window, remaining]), [
    ['5 小时窗口', 65], ['7 天窗口', 20],
  ]);
  assert.equal(view.hasFiveHourWindow, true);
});

test('compact card prefers Codex quota when another model appears first', () => {
  const limit = (limitId, windowType, usedPercent) => ({
    limitId, limitName: null, windowType, windowDurationMins: 300, usedPercent,
    resetsAt: null, normalModelSlug: null, rateLimitReachedType: null, spendControlReached: false,
  });
  const view = projectWorkspaceCodexResource({
    status: 'ready', authMode: 'chatgpt', email: null, planType: 'plus', fetchedAt: 1_000,
    rateLimits: [limit('gpt-reserve', 'primary', 90), limit('codex', 'primary', 20)],
    credits: null, usage: null, rateLimitResetCredits: null, errorMessage: null,
  }, false);
  assert.deepEqual(view.summaryWindows.map(({ name, remaining }) => [name, remaining]), [['Codex 使用额度', 80]]);
});

test('daily Token matrix keeps official dates and marks missing dates unknown', () => {
  const buckets = [0, 10, 20, 40, 80, 100, 50, 25].map((tokens, index) => ({ startDate: `2026-09-${String(index + 1).padStart(2, '0')}`, tokens }));
  const view = projectWorkspaceCodexResource({
    status: 'ready', authMode: 'chatgpt', email: null, planType: 'plus', fetchedAt: 1_000,
    rateLimits: [], credits: null, usage: { lifetimeTokens: 500, peakDailyTokens: 100, longestRunningTurnSec: 261, currentStreakDays: 4, longestStreakDays: 9, dailyUsageBuckets: [buckets[7], ...buckets.slice(0, 6), { startDate: '2026-99-99', tokens: 999 }] },
    rateLimitResetCredits: null, errorMessage: null,
  }, false);
  assert.equal(view.usageDays.length, 365);
  assert.deepEqual(view.usageDays.slice(-8).map(({ date, tokens }) => [date, tokens]), [
    ['2026-09-01', 0], ['2026-09-02', 10], ['2026-09-03', 20], ['2026-09-04', 40],
    ['2026-09-05', 80], ['2026-09-06', 100], ['2026-09-07', null], ['2026-09-08', 25],
  ]);
  assert.equal(view.usageDays[view.usageDays.length - 3].level, 4);
  assert.equal(view.usageDays[0].tokens, null);
});

test('daily Token matrix retains more than one month when the official response has it', () => {
  const dailyUsageBuckets = Array.from({ length: 40 }, (_, index) => ({
    startDate: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10), tokens: index + 1,
  }));
  const view = projectWorkspaceCodexResource({
    status: 'ready', authMode: 'chatgpt', email: null, planType: 'plus', fetchedAt: 1_000,
    rateLimits: [], credits: null, usage: { lifetimeTokens: 820, peakDailyTokens: 40, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null, dailyUsageBuckets },
    rateLimitResetCredits: null, errorMessage: null,
  }, false);
  assert.equal(view.usageDays.length, 365);
  assert.equal(view.usageDays[364].tokens, 40);
});

test('Token activity modes use the recent year and preserve missing days', () => {
  const days = Array.from({ length: 365 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 8, index + 29)).toISOString().slice(0, 10),
    tokens: index === 362 ? 10 : index === 363 ? 20 : null,
    level: 0,
  }));
  const daily = projectTokenActivityDays(days, 'daily');
  assert.equal(daily.length, 365);
  assert.equal(daily[0].value, null);
  assert.deepEqual(daily.slice(-3).map((day) => day.value), [10, 20, null]);
  const weekly = projectTokenActivityDays(days, 'weekly');
  assert.equal(weekly.length, 365);
  assert.deepEqual(weekly.slice(-3).map((day) => day.value), [30, 30, null]);
  const cumulative = projectTokenActivityDays(days, 'cumulative');
  assert.equal(cumulative[0].value, null);
  assert.deepEqual(cumulative.slice(-3).map((day) => day.value), [10, 30, 30]);
});

test('daily bars show only the latest 30 dates and scale to that period peak', () => {
  const days = Array.from({ length: 35 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 7, index + 1)).toISOString().slice(0, 10),
    tokens: index === 5 ? null : index === 6 ? 0 : index === 7 ? 5 : index === 34 ? 10 : null,
    level: 0,
  }));
  const bars = resource.projectTokenActivityBars(projectTokenActivityDays(days, 'daily'), 'daily');
  assert.equal(bars.length, 30);
  assert.deepEqual(bars.slice(0, 3).map(({ date, value, percent }) => [date, value, percent]), [
    ['2026-08-06', null, 0], ['2026-08-07', 0, 0], ['2026-08-08', 5, 50],
  ]);
  assert.deepEqual([bars.at(-1).date, bars.at(-1).value, bars.at(-1).percent], ['2026-09-04', 10, 100]);
});

test('weekly bars show each week once while cumulative bars keep daily points', () => {
  const days = Array.from({ length: 35 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 7, index + 3)).toISOString().slice(0, 10),
    tokens: index % 7 === 0 ? [5, 10, 20, 30, 40][index / 7] : null,
    level: 0,
  }));
  const weekly = resource.projectTokenActivityBars(projectTokenActivityDays(days, 'weekly'), 'weekly');
  assert.deepEqual(weekly.map(({ date, value }) => [date, value]), [
    ['2026-08-03', 5], ['2026-08-10', 10], ['2026-08-17', 20], ['2026-08-24', 30], ['2026-08-31', 40],
  ]);
  assert.deepEqual(weekly.map(({ percent }) => percent), [13, 25, 50, 75, 100]);
  const cumulative = resource.projectTokenActivityBars(projectTokenActivityDays(days, 'cumulative'), 'cumulative');
  assert.equal(cumulative.length, 30);
  assert.deepEqual([cumulative[0].date, cumulative[0].value], ['2026-08-08', 5]);
  assert.deepEqual([cumulative.at(-1).date, cumulative.at(-1).value, cumulative.at(-1).percent], ['2026-09-06', 105, 100]);
});

test('calendar pads the rest of an unfinished week after a Monday', () => {
  const days = Array.from({ length: 365 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 8, index + 29)).toISOString().slice(0, 10), tokens: null, level: 0,
  }));
  const layout = projectTokenCalendarLayout(days);
  assert.equal(days.at(-1).date, '2026-09-28');
  assert.equal(layout.trailing, 6);
  assert.equal((layout.leading + days.length + layout.trailing) % 7, 0);
  assert.equal(layout.columns, 53);
});

test('month labels show one month per week column when the first month ends midweek', () => {
  const days = Array.from({ length: 40 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 8, index + 29)).toISOString().slice(0, 10), tokens: null, level: 0,
  }));
  const labels = resource.projectTokenCalendarMonthLabels(days);
  assert.deepEqual(labels.map(({ column, month }) => [column, month]), [[0, 10], [4, 11]]);
});
