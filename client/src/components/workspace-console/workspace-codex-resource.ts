import type { CodexAccountSnapshotDto } from '../../generated/relay-contracts';
import { formatCodexAccountEmail, formatCodexLimitName, formatCodexLimitWindow, formatCodexPlanType, formatCodexRateLimitReason, formatCodexResetTime, getCodexAccountStatusLabel } from '../system/codex-account-presentation.ts';

export const formatCodexResetTitle = (title: string | null, index: number) => {
  if (!title) return `重置额度 ${index + 1}`;
  return /^full[\s_-]*reset$/i.test(title.trim()) ? '完全重置' : title;
};

export const formatCodexTaskDuration = (seconds: number | null) => {
  if (seconds === null) return '未提供';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const rest = seconds % 60;
  return [hours && `${hours} 小时`, minutes && `${minutes} 分`, (!hours && !minutes || rest) && `${rest} 秒`].filter(Boolean).join(' ');
};

export type TokenActivityMode = 'daily' | 'weekly' | 'cumulative';
export type TokenActivitySource = 'official' | 'local';
type UsageDay = { date: string; tokens: number | null; level: number };

export function projectLocalTokenActivityDays(buckets: { startDate: string; tokens: number }[]): UsageDay[] {
  return buckets
    .filter((bucket) => /^\d{4}-\d{2}-\d{2}$/.test(bucket.startDate)
      && Number.isFinite(Date.parse(`${bucket.startDate}T00:00:00Z`))
      && new Date(`${bucket.startDate}T00:00:00Z`).toISOString().slice(0, 10) === bucket.startDate
      && Number.isSafeInteger(bucket.tokens) && bucket.tokens >= 0)
    .sort((left, right) => left.startDate.localeCompare(right.startDate))
    .slice(-365)
    .map((bucket) => ({ date: bucket.startDate, tokens: bucket.tokens, level: 0 }));
}

export function projectLocalTokenActivitySummary(days: UsageDay[]) {
  let lifetimeTokens = 0;
  let peakDailyTokens = 0;
  let currentStreakDays = 0;
  let longestStreakDays = 0;
  for (const day of days) {
    const tokens = day.tokens ?? 0;
    lifetimeTokens += tokens;
    peakDailyTokens = Math.max(peakDailyTokens, tokens);
    currentStreakDays = tokens > 0 ? currentStreakDays + 1 : 0;
    longestStreakDays = Math.max(longestStreakDays, currentStreakDays);
  }
  return { lifetimeTokens, peakDailyTokens, longestRunningTurnSec: 0,
    currentStreakDays, longestStreakDays };
}

export function selectTokenActivityInputDays(
  source: TokenActivitySource,
  officialDays: UsageDay[],
  localBuckets: { startDate: string; tokens: number }[],
  today: string,
): UsageDay[] {
  if (source === 'local') return projectLocalTokenActivityDays(localBuckets);
  if (!officialDays.length || officialDays.some((day) => day.date === today)) return officialDays;
  const byDate = new Map(officialDays.map((day) => [day.date, day]));
  const end = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: 365 }, (_, index) => {
    const date = new Date(end - (364 - index) * 86_400_000).toISOString().slice(0, 10);
    return byDate.get(date) ?? { date, tokens: date === today ? 0 : null, level: 0 };
  });
}

export function projectTokenCalendarLayout(days: UsageDay[]) {
  if (!days.length) return { leading: 0, trailing: 0, columns: 0 };
  const leading = (new Date(`${days[0].date}T00:00:00Z`).getUTCDay() + 6) % 7;
  const trailing = (7 - (leading + days.length) % 7) % 7;
  return { leading, trailing, columns: (leading + days.length + trailing) / 7 };
}

export function projectTokenCalendarMonthLabels(days: UsageDay[]) {
  const { leading } = projectTokenCalendarLayout(days);
  const labels = new Map<number, { column: number; month: number }>();
  days.forEach((day, index) => {
    if (index !== 0 && !day.date.endsWith('-01')) return;
    const column = Math.floor((leading + index) / 7);
    labels.set(column, { column, month: Number(day.date.slice(5, 7)) });
  });
  return [...labels.values()];
}

export function projectTokenActivityDays(days: UsageDay[], mode: TokenActivityMode) {
  const selected = days.slice(-365);
  const weekStart = (date: string) => {
    const time = Date.parse(`${date}T00:00:00Z`);
    const weekday = (new Date(time).getUTCDay() + 6) % 7;
    return new Date(time - weekday * 86_400_000).toISOString().slice(0, 10);
  };
  const weeks = new Map<string, { tokens: number; recordedDays: number }>();
  for (const day of selected) {
    const key = weekStart(day.date);
    const week = weeks.get(key) ?? { tokens: 0, recordedDays: 0 };
    if (day.tokens !== null) { week.tokens += day.tokens; week.recordedDays += 1; }
    weeks.set(key, week);
  }
  let cumulative = 0;
  let hasRecord = false;
  const projected = selected.map((day) => {
    if (day.tokens !== null) { cumulative += day.tokens; hasRecord = true; }
    const week = weeks.get(weekStart(day.date))!;
    const value = mode === 'daily' ? day.tokens : mode === 'weekly'
      ? week.recordedDays ? week.tokens : null : hasRecord ? cumulative : null;
    return { ...day, value, recordedDays: mode === 'weekly' ? week.recordedDays : null,
      periodLabel: mode === 'weekly' ? `${weekStart(day.date)} 起一周` : mode === 'cumulative' ? `截至 ${day.date}` : day.date };
  });
  const peak = Math.max(0, ...projected.map((day) => day.value ?? 0));
  return projected.map((day) => ({ ...day, level: day.value === null || day.value === 0 || peak === 0
    ? 0 : Math.max(1, Math.ceil(day.value / peak * 4)) }));
}

export function projectTokenActivityBars(days: ReturnType<typeof projectTokenActivityDays>, mode: TokenActivityMode) {
  const recent = days.slice(-30);
  const visible = mode === 'weekly' ? [...new Map(recent.map((day) => [day.periodLabel, day])).values()] : recent;
  const peak = Math.max(0, ...visible.map((day) => day.value ?? 0));
  return visible.map((day) => ({
    date: mode === 'weekly' ? day.periodLabel.slice(0, 10) : day.date,
    label: day.periodLabel,
    value: day.value,
    recordedDays: day.recordedDays,
    percent: day.value === null || day.value === 0 || peak === 0 ? 0 : Math.max(1, Math.round(day.value / peak * 100)),
  }));
}

export function projectWorkspaceCodexResource(snapshot: CodexAccountSnapshotDto, stale: boolean) {
  const windows = snapshot.rateLimits.map((limit) => {
    const used = Math.max(0, Math.min(100, Math.round(limit.usedPercent)));
    const startAt = Number.isInteger(limit.resetsAt) && Number.isInteger(limit.windowDurationMins)
      && limit.resetsAt! > 0 && limit.windowDurationMins! > 0
      ? limit.resetsAt! - limit.windowDurationMins! * 60 : null;
    return { key: `${limit.limitId}:${limit.windowType}`, limitId: limit.limitId, windowType: limit.windowType,
      name: formatCodexLimitName(limit.limitName, limit.limitId),
      window: formatCodexLimitWindow(limit), used, remaining: 100 - used,
      reset: formatCodexResetTime(limit.resetsAt), startAt: startAt !== null && startAt > 0 ? startAt : null,
      reason: formatCodexRateLimitReason(limit) };
  });
  const summaryLimitId = snapshot.rateLimits.find((limit) => limit.limitId === 'codex')?.limitId ?? snapshot.rateLimits[0]?.limitId;
  const summaryWindows = windows.filter((window) => window.limitId === summaryLimitId)
    .sort((left, right) => Number(left.windowType === 'secondary') - Number(right.windowType === 'secondary')).slice(0, 2);
  const hasFiveHourWindow = snapshot.rateLimits.some((limit) => limit.limitId === summaryLimitId && limit.windowDurationMins === 300);
  const buckets = [...(snapshot.usage?.dailyUsageBuckets ?? [])]
    .filter((bucket) => /^\d{4}-\d{2}-\d{2}$/.test(bucket.startDate)
      && Number.isFinite(Date.parse(`${bucket.startDate}T00:00:00Z`))
      && new Date(`${bucket.startDate}T00:00:00Z`).toISOString().slice(0, 10) === bucket.startDate)
    .sort((left, right) => left.startDate.localeCompare(right.startDate)).slice(-366);
  const bucketByDate = new Map(buckets.map((bucket) => [bucket.startDate, bucket.tokens]));
  const last = buckets[buckets.length - 1]?.startDate;
  const peak = Math.max(0, ...buckets.map((bucket) => bucket.tokens));
  const usageDays: Array<{ date: string; tokens: number | null; level: number }> = [];
  if (last) {
    const start = Date.parse(`${last}T00:00:00Z`) - 364 * 86_400_000;
    const end = Date.parse(`${last}T00:00:00Z`);
    for (let time = start; time <= end; time += 86_400_000) {
      const date = new Date(time).toISOString().slice(0, 10);
      const tokens = bucketByDate.get(date) ?? null;
      usageDays.push({ date, tokens, level: tokens === null || tokens === 0 || peak === 0 ? 0 : Math.max(1, Math.ceil(tokens / peak * 4)) });
    }
  }
  return {
    status: getCodexAccountStatusLabel(snapshot), email: formatCodexAccountEmail(snapshot.email),
    plan: formatCodexPlanType(snapshot.planType), primaryWindow: windows[0] ? `${windows[0].window} · 剩余 ${windows[0].remaining}%` : '未提供',
    windows, summaryWindows, hasFiveHourWindow, manualResets: snapshot.rateLimitResetCredits?.availableCount ?? null,
    manualResetCredits: snapshot.rateLimitResetCredits?.credits ?? [],
    usageDays, stale, fetchedAt: snapshot.fetchedAt, credits: snapshot.credits, usage: snapshot.usage,
  };
}
