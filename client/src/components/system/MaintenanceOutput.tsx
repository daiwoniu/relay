import type { MaintenanceOutputSnapshotDto } from '../../generated/relay-contracts.ts';
import { getMaintenanceOutputRows } from './maintenance-output-presentation';

export default function MaintenanceOutput({ snapshot, disconnected = false, className = '' }: {
  snapshot: MaintenanceOutputSnapshotDto | null;
  disconnected?: boolean;
  className?: string;
}) {
  const rows = getMaintenanceOutputRows(snapshot);
  return <section
    data-maintenance-output={snapshot?.status ?? 'waiting'}
    data-maintenance-output-disconnected={disconnected || undefined}
    aria-label="最近命令输出"
    className={`maintenance-output ${className}`}
  >
    <div className="maintenance-output__header">
      <span>最近输出</span>
      <span className={disconnected ? 'maintenance-output__connection is-disconnected' : 'maintenance-output__connection'}>
        <i aria-hidden="true" />{disconnected ? '输出暂时中断，等待恢复' : snapshot ? '实时' : '等待中'}
      </span>
    </div>
    <div className="maintenance-output__screen">
      {rows.map((line, index) => <div
        key={`${snapshot?.operationId ?? 'waiting'}-${snapshot?.sequence ?? 0}-${index}`}
        className={`maintenance-output__line ${index === 1 ? 'maintenance-output__line--current' : 'maintenance-output__line--previous'} ${line ? '' : 'is-empty'}`}
        title={line ?? undefined}
      >{line ?? '\u00a0'}</div>)}
    </div>
  </section>;
}
