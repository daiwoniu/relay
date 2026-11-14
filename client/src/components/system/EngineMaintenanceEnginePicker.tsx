import { useState } from 'react';
import type { EngineId, EngineMaintenanceStatusDto } from '../../generated/relay-contracts';
import { getEngineSummary } from './engine-maintenance-layout';

interface EngineMaintenanceEnginePickerProps {
  engines: readonly EngineMaintenanceStatusDto[];
  selected: EngineId | null;
  disabled: boolean;
  onSelect(engineId: EngineId): void;
}

function SummaryTone({ tone }: { tone: ReturnType<typeof getEngineSummary>['statusTone'] }) {
  const className = tone === 'success'
    ? 'bg-[var(--color-status-success)]'
    : tone === 'danger'
      ? 'bg-[var(--color-status-danger)]'
      : tone === 'warning'
        ? 'bg-[var(--color-status-warning)]'
        : 'bg-[var(--color-text-tertiary)]';
  return <span aria-hidden="true" className={`mt-1.5 size-2 shrink-0 rounded-full ${className}`} />;
}

export default function EngineMaintenanceEnginePicker({ engines, selected, disabled, onSelect }: EngineMaintenanceEnginePickerProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const current = engines.find((engine) => engine.engineId === selected) ?? engines[0] ?? null;
  const choose = (engineId: EngineId) => {
    if (disabled) return;
    onSelect(engineId);
    setMobileOpen(false);
  };

  return <>
    <aside className="hidden w-44 shrink-0 flex-col gap-1 border-r border-[var(--color-border-light)] pr-2 lg:flex" aria-label="引擎列表">
      {engines.map((engine) => {
        const summary = getEngineSummary(engine);
        const active = engine.engineId === selected;
        return <button key={engine.engineId} type="button" disabled={disabled} onClick={() => choose(engine.engineId)} className={`flex min-h-16 w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${active ? 'bg-[var(--color-bg-secondary)] text-[var(--color-text)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}>
          <SummaryTone tone={summary.statusTone} />
          <span className="min-w-0">
            <span className="block truncate text-xs font-semibold">{summary.label}</span>
            <span className="mt-0.5 block truncate text-[11px]">{summary.statusLabel}</span>
            <span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-tertiary)]">{summary.versionLabel}</span>
          </span>
        </button>;
      })}
    </aside>

    <div className="relative lg:hidden">
      <button type="button" disabled={disabled || !current} onClick={() => setMobileOpen((open) => !open)} className="flex min-h-11 w-full items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50">
        <span className="min-w-0">
          <span className="block text-[10px] text-[var(--color-text-tertiary)]">当前引擎</span>
          <span className="mt-0.5 block truncate text-sm font-semibold text-[var(--color-text)]">{current?.label ?? '暂无引擎'}</span>
        </span>
        <span aria-hidden="true" className={`ml-3 text-xs transition-transform ${mobileOpen ? 'rotate-180' : ''}`}>⌄</span>
      </button>
      {mobileOpen && <div className="absolute inset-x-0 top-[calc(100%+0.5rem)] z-20 grid gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-overlay-surface)] p-2 shadow-xl">
        <p className="px-2 py-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">选择引擎</p>
        {engines.map((engine) => {
          const summary = getEngineSummary(engine);
          return <button key={engine.engineId} type="button" disabled={disabled} onClick={() => choose(engine.engineId)} className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-left hover:bg-[var(--color-surface-hover)] disabled:opacity-50">
            <SummaryTone tone={summary.statusTone} />
            <span className="min-w-0 flex-1"><span className="block text-xs font-medium text-[var(--color-text)]">{summary.label}</span><span className="block truncate text-[11px] text-[var(--color-text-secondary)]">{summary.statusLabel} · {summary.versionLabel}</span></span>
            {engine.engineId === selected && <span className="text-xs text-[var(--color-primary)]">当前</span>}
          </button>;
        })}
      </div>}
    </div>
  </>;
}
