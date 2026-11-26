import { useEffect, useState } from 'react';
import { formatDateTime } from '../../utils/date-display.ts';
import type { WorkspaceConsoleDashboardDto, WorkspaceConsoleResponsibilityDto } from '../../generated/relay-contracts';
import {latestFeishuTaskUpdatedAt, type WorkspaceRefreshTimes, type WorkspaceSourceRefreshActivity} from './workspace-source-times.ts';

const formatTime = (value: string | number | null | undefined, empty: string) => {
  return formatDateTime(value === 0 ? null : value, { fallback: empty });
};

interface Props {
  dashboard: WorkspaceConsoleDashboardDto | null;
  responsibility: WorkspaceConsoleResponsibilityDto | null;
  localFailed: boolean;
  projectFailed: boolean;
  localActivity?: WorkspaceSourceRefreshActivity;
  projectActivity?: WorkspaceSourceRefreshActivity;
  onDismissRefresh: (source: keyof WorkspaceRefreshTimes) => void;
  localPartial?: boolean;
  localRequestFailed?: boolean;
  projectRequestFailed?: boolean;
  localRefreshAt?:number|null;
  projectRefreshAt?:number|null;
}

export default function WorkspaceSourceTimes({ dashboard, responsibility, localFailed, projectFailed, localActivity, projectActivity, onDismissRefresh, localPartial, localRequestFailed, projectRequestFailed,localRefreshAt,projectRefreshAt }: Props) {
  const [now, setNow] = useState(() => performance.now());
  const visibleRefresh = !!((localActivity?.pending && !localActivity.dismissed) || (projectActivity?.pending && !projectActivity.dismissed));
  useEffect(() => {
    if (!visibleRefresh) return;
    const interval = window.setInterval(() => setNow(performance.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [visibleRefresh]);
  if (!dashboard && !responsibility && !localFailed && !projectFailed && !localActivity?.pending && !projectActivity?.pending) return null;
  const sources = [
    { source: 'local', name: '台账', dataAt: dashboard?.registryGeneratedAt, emptyDataTime:'未登记', meta: dashboard?.sourceMeta,
      refreshAt:localRefreshAt,legacyRefreshAt: dashboard?.capturedAt, failed: localFailed, requestFailed: localRequestFailed, activity: localActivity, partial: localPartial },
    { source: 'project', name: '飞书', dataAt: latestFeishuTaskUpdatedAt(responsibility), emptyDataTime:'未提供', meta: responsibility?.sourceMeta,
      refreshAt:projectRefreshAt,legacyRefreshAt: responsibility?.fetchedAt, failed: projectFailed, requestFailed: projectRequestFailed, activity: projectActivity, partial: false },
  ] as const;
  return <div className="workspace-workbench__source-times text-xs text-slate-500" aria-label="数据与刷新时间">
    {sources.map(({ source, name, dataAt, emptyDataTime, refreshAt,meta, legacyRefreshAt, failed, requestFailed, activity, partial }) => {
      const sourceFailed = meta?.state === 'failed_snapshot' || meta?.state === 'unavailable';
      const lastRefresh = formatTime(Math.max(refreshAt ?? 0, (meta ? meta.lastSuccessAt : legacyRefreshAt) ?? 0), '');
      const loading = !!activity?.pending;
      const refreshed = !!activity?.succeeded && !!lastRefresh && !failed && !sourceFailed && !partial;
      const elapsed = activity?.startedAt == null ? null : Math.max(0, (activity.finishedAt ?? now) - activity.startedAt);
      // A rejected HTTP request leaves the previous response in state. Its attempt
      // timestamp describes that older response, not the failure being shown now.
      const failedAt = !requestFailed && sourceFailed ? meta.lastAttemptAt : null;
      return <section key={name} className="workspace-workbench__source-time" aria-label={`${name}时间`}>
        <span className="font-medium text-slate-400">{name}</span>
        <dl>
          <dt>{source === 'local' ? '台账生成' : '飞书更新'}</dt><dd>{formatTime(dataAt, emptyDataTime)}</dd>
          <dt>刷新成功</dt><dd className="workspace-workbench__source-refresh-row">
            <span>{lastRefresh || '尚未成功刷新'}</span>
            {!activity?.dismissed && (loading || refreshed) && <span className="workspace-workbench__source-refresh-status">
              {loading ? (
                <svg role="img" aria-label={`${name}刷新中`} className="size-3.5 shrink-0 text-cyan-500 motion-safe:animate-spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="8" cy="8" r="6" opacity=".25" />
                  <path d="M8 2a6 6 0 0 1 6 6" strokeLinecap="round" />
                </svg>
              ) : (
                <svg role="img" aria-label={`${name}刷新成功`} className="size-3.5 shrink-0 text-emerald-500" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m3 8 3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              {elapsed !== null && <span>耗时 {Math.floor(elapsed / 1000)} 秒</span>}
              <button type="button" onClick={() => onDismissRefresh(source)} aria-label={`关闭${name}刷新提示`} className="workspace-workbench__source-refresh-close">
                <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="m5 5 6 6m0-6-6 6" />
                </svg>
              </button>
            </span>}
          </dd>
          {!loading && (failed || sourceFailed) && <><dt className="text-amber-300">最近尝试</dt><dd className="text-amber-300">{failedAt != null && `${formatTime(failedAt, '时间未记录')} · `}失败</dd></>}
        </dl>
      </section>;
    })}
  </div>;
}
