import type { CodexAccountSnapshotDto } from '../../generated/relay-contracts';
import { formatCodexLimitWindow, formatCodexRateLimitReason, formatCodexResetTime } from '../system/codex-account-presentation.ts';

function compactWindowLabel(minutes: number | null, windowType: 'primary' | 'secondary', resetsAt: number | null, now: number): string {
  if (minutes && minutes >= 1440 && resetsAt) {
    const untilReset = resetsAt * 1000 - now;
    if (untilReset > 86_400_000) return `${Math.ceil(untilReset / 86_400_000)}天`;
    if (untilReset > 3_600_000) return `${Math.ceil(untilReset / 3_600_000)}h`;
    if (untilReset > 0) return '<1h';
    return '待更新';
  }
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}天`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes) return `${minutes}分`;
  return windowType === 'primary' ? '主' : '次';
}

export function selectSidebarCodexQuota(snapshot: CodexAccountSnapshotDto | null, now = Date.now()) {
  if (snapshot?.status !== 'ready' || snapshot.authMode === 'apikey') return [];
  return snapshot.rateLimits
    .filter((limit) => limit.limitId === 'codex')
    .sort((left, right) => Number(left.windowType === 'secondary') - Number(right.windowType === 'secondary'))
    .slice(0, 2)
    .map((limit) => {
      const remaining = 100 - Math.round(limit.usedPercent);
      return {
        key: limit.windowType,
        label: compactWindowLabel(limit.windowDurationMins, limit.windowType, limit.resetsAt, now),
        window: formatCodexLimitWindow(limit),
        remaining,
        reset: formatCodexResetTime(limit.resetsAt),
        reason: formatCodexRateLimitReason(limit),
      };
    });
}
