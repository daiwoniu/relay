import { useEffect, useState } from 'react';
import type { MaintenanceOutputSnapshotDto } from '../../generated/relay-contracts.ts';
import MaintenanceOutput from './MaintenanceOutput';

export default function MaintenanceProgress({ title, detail, output, outputDisconnected = false, slowAfterMs = 15_000, slowMessage = '耗时比平时更久，仍在等待操作完成。', className = '' }: {
  title: string;
  detail: string;
  output?: MaintenanceOutputSnapshotDto | null;
  outputDisconnected?: boolean;
  slowAfterMs?: number;
  slowMessage?: string;
  className?: string;
}) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), slowAfterMs);
    return () => window.clearTimeout(timer);
  }, [slowAfterMs, title]);

  return <section className={`maintenance-progress rounded-xl border border-[var(--color-notice-info-border)] bg-[var(--color-notice-info-bg)] p-3 shadow-sm ${className}`}>
    <div role="status" aria-live="polite" aria-atomic="true" className="flex items-start gap-2.5">
      <span className="maintenance-progress__spinner mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 border-[var(--color-status-track)] border-t-[var(--color-status-processing)] animate-spin" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <strong className="block text-sm font-semibold text-[var(--color-text)]">{title}</strong>
        <span className="mt-0.5 block text-xs leading-5 text-[var(--color-text-secondary)]">{detail}</span>
      </div>
    </div>
    <div className="maintenance-progress__track mt-2.5 h-1 overflow-hidden rounded-full bg-[var(--color-status-track)]" aria-hidden="true">
      <span className="maintenance-progress__bar block h-full w-2/5 rounded-full bg-[var(--color-status-processing)]" />
    </div>
    {output !== undefined && <MaintenanceOutput snapshot={output} disconnected={outputDisconnected} className="mt-2.5" />}
    {slow && <p className="mt-2 text-[11px] leading-4 text-[var(--color-text-tertiary)]">{slowMessage}</p>}
  </section>;
}
