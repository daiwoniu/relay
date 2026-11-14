import { useEffect, useState } from 'react';
import { getSystemResourceStatus } from '../../api/system';
import type { SystemResourceStatusDto } from '../../generated/relay-contracts';
import { getProcessMemoryPresentation, getSystemResourcePresentation } from './system-resource-status';

const REFRESH_INTERVAL_MS = 30_000;

export default function SystemResourceStatus({ active }: { active: boolean }) {
  const [snapshot, setSnapshot] = useState<SystemResourceStatusDto | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let controller: AbortController | null = null;
    const refresh = () => {
      controller?.abort();
      controller = new AbortController();
      setLoading(true);
      getSystemResourceStatus(controller.signal)
        .then((value) => { if (!cancelled) setSnapshot(value); })
        .catch(() => { if (!cancelled) setSnapshot(null); })
        .finally(() => { if (!cancelled) setLoading(false); });
    };
    refresh();
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [active]);

  const presentation = getSystemResourcePresentation(snapshot);
  const processes = getProcessMemoryPresentation(snapshot);
  const toneClass = {
    neutral: 'border-[var(--color-border)] bg-[var(--color-surface)]',
    warning: 'border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)]',
    critical: 'border-[var(--color-status-danger)]/35 bg-[var(--color-danger-hover)]',
    unknown: 'border-[var(--color-border)] bg-[var(--color-bg-secondary)]',
  }[presentation.tone];
  const observedAt = snapshot?.observedAt
    ? new Date(snapshot.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  return <section data-system-resource-status={presentation.tone} className={`rounded-xl border px-3 py-2.5 ${toneClass}`}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">主机资源</div>
        <div className="mt-0.5 text-sm font-semibold text-[var(--color-text)]">{loading && snapshot === null ? '正在读取系统提交内存' : presentation.title}</div>
      </div>
      {observedAt && <span className="shrink-0 text-[10px] text-[var(--color-text-tertiary)]">{observedAt}</span>}
    </div>
    <div className="mt-1 font-mono text-xs text-[var(--color-text)]">{loading && snapshot === null ? '—' : presentation.summary}</div>
    <p className="mt-1 text-[11px] leading-4 text-[var(--color-text-secondary)]">{presentation.detail}</p>
    <div className="mt-2.5 border-t border-[var(--color-border)] pt-2 text-xs">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[var(--color-text)]">
        <span className="font-medium">Relay 相关占用</span>
        <span className="font-mono tabular-nums">{loading && snapshot === null ? '正在读取' : processes.relaySummary}</span>
      </div>
      <p className="mt-1 text-[11px] leading-4 text-[var(--color-text-secondary)]">{processes.relayDetail}</p>
      <div className="mt-2 font-medium text-[var(--color-text)]">占用前 5 名 · 同名进程合计</div>
      {processes.available && processes.rows.length > 0 ? <ol className="mt-1 space-y-1">
        {processes.rows.map((row, index) => <li key={row.name} className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-[var(--color-text-secondary)]" title={row.name}>
            <span className="mr-1.5 text-[var(--color-text-tertiary)]">{index + 1}.</span>{row.name}
            <span className="ml-1 text-[10px] text-[var(--color-text-tertiary)]">({row.processCount})</span>
          </span>
          <span className="shrink-0 font-mono tabular-nums text-[var(--color-text)]">{row.memoryLabel}</span>
        </li>)}
      </ol> : <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{loading && snapshot === null ? '正在读取进程占用' : '进程占用暂不可用，不影响系统提交内存监测。'}</p>}
      <p className="mt-2 text-[10px] leading-4 text-[var(--color-text-tertiary)]">进程明细支持 Windows，按私有提交量统计，括号为进程数；系统提交量还包含内核等开销。每 30 秒更新。</p>
    </div>
  </section>;
}

