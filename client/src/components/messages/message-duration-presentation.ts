import { formatClockTime, formatDateTime } from '../../utils/date-display.ts';

export function formatDuration(ms?: number | null): string | null {
  if (!ms || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}分${remainingSeconds}秒` : `${minutes}分钟`;
}

/** 当天显示 HH:mm，同年显示 MM-DD HH:mm，跨年保留完整日期。 */
export function formatCompletionTime(timestamp: number, nowTimestamp = Date.now()): string {
  const date = new Date(timestamp);
  const now = new Date(nowTimestamp);
  const isToday = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return isToday ? formatClockTime(date) : formatDateTime(date, { short: date.getFullYear() === now.getFullYear() });
}

export function getRunningDurationPresentation(statusLabel: string, elapsedMs?: number | null): string | null {
  const duration = formatDuration(elapsedMs);
  return duration ? `${statusLabel} · 已用时 ${duration}` : null;
}

export function getSettledDurationPresentation(
  completionTimestamp: number | undefined,
  statusLabel: string,
  durationMs?: number | null,
  nowTimestamp = Date.now(),
  compact = false,
): string | null {
  const duration = formatDuration(durationMs);
  if (!completionTimestamp || !duration) return null;
  const displayStatus = compact && statusLabel === '已完成' ? '完成' : statusLabel;
  const interruptedNote = statusLabel === '执行中断' || statusLabel === '启动前中断'
    ? '（可能包含离线/恢复等待）'
    : '';
  return `${formatCompletionTime(completionTimestamp, nowTimestamp)} · ${displayStatus} · ${compact ? '' : '耗时 '}${duration}${interruptedNote}`;
}
