import { formatDateTime } from '../../utils/date-display.ts';
import type { WorkspaceConsoleDashboardDto, WorkspaceConsoleResponsibilityDto } from '../../generated/relay-contracts';

const formatTime = (value: string | number | null | undefined, empty: string) => {
  return formatDateTime(value === 0 ? null : value, { fallback: empty });
};

interface Props {
  dashboard: WorkspaceConsoleDashboardDto | null;
  responsibility: WorkspaceConsoleResponsibilityDto | null;
  localFailed: boolean;
  projectFailed: boolean;
  localRequestFailed?: boolean;
  projectRequestFailed?: boolean;
}

export default function WorkspaceSourceTimes({ dashboard, responsibility, localFailed, projectFailed, localRequestFailed, projectRequestFailed }: Props) {
  if (!dashboard && !responsibility && !localFailed && !projectFailed) return null;
  const sources = [
    { name: '台账', generatedAt: dashboard?.registryGeneratedAt, meta: dashboard?.sourceMeta,
      legacyRefreshAt: dashboard?.capturedAt, failed: localFailed, requestFailed: localRequestFailed },
    { name: '飞书', generatedAt: responsibility?.generatedAt, meta: responsibility?.sourceMeta,
      legacyRefreshAt: responsibility?.fetchedAt, failed: projectFailed, requestFailed: projectRequestFailed },
  ];
  return <div className="workspace-workbench__source-times text-xs text-slate-500" aria-label="数据与刷新时间">
    {sources.map(({ name, generatedAt, meta, legacyRefreshAt, failed, requestFailed }) => {
      const sourceFailed = meta?.state === 'failed_snapshot' || meta?.state === 'unavailable';
      // A rejected HTTP request leaves the previous response in state. Its attempt
      // timestamp describes that older response, not the failure being shown now.
      const failedAt = !requestFailed && sourceFailed ? meta.lastAttemptAt : null;
      return <section key={name} className="workspace-workbench__source-time" aria-label={`${name}时间`}>
        <span className="font-medium text-slate-400">{name}</span>
        <dl>
          <dt>数据时间</dt><dd>{formatTime(generatedAt, '未登记')}</dd>
          <dt>最后刷新</dt><dd>{formatTime(meta ? meta.lastSuccessAt : legacyRefreshAt, '尚未成功刷新')}</dd>
          {(failed || sourceFailed) && <><dt className="text-amber-300">最近尝试</dt><dd className="text-amber-300">{failedAt != null && `${formatTime(failedAt, '时间未记录')} · `}失败</dd></>}
        </dl>
      </section>;
    })}
  </div>;
}
