import FailureNotice from '../ui/FailureNotice';
import { useEffect, useMemo, useState } from 'react';
import { getEngineConcurrency, updateEngineConcurrency } from '../../api/engine-concurrency';
import type { EngineConcurrencyDto, EngineId } from '../../generated/relay-contracts';
import { useEngineConcurrencyStore } from '../../stores/engine-concurrency';
import { getEngineConcurrencyPresentation, isConcurrencyControlDisabled } from './engine-concurrency-presentation';
import { filterEngineConcurrencyItems, getNextCooldownRefreshDelay, persistEngineConcurrencySetting, validateMaxActiveTurns } from './engine-concurrency-section-state';

function CapacityWindow({ item, defaultOpen }: { item: EngineConcurrencyDto; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);
  if (item.windows.length === 0) return null;
  return <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="mt-3 border-t border-[var(--color-border-light)] pt-1">
    <summary className="engine-maintenance-summary">运行诊断</summary>
    <div className="grid gap-2 border-t border-[var(--color-border-light)] pt-3">{item.windows.map((window) => <div key={window.windowMinutes} className="text-[11px] leading-4 text-[var(--color-text-secondary)]"><strong className="text-xs text-[var(--color-text)]">最近 {window.windowMinutes} 分钟</strong><span className="ml-2">启动 {window.startAcceptedCount} · 过载 {window.overloadCount} · 重试 {window.requestRetryCount + window.completionRetryCount} · 冷却 {window.cooldownCount}</span></div>)}</div>
  </details>;
}

function ConcurrencyResource({ item, admin, disabled, now }: { item: EngineConcurrencyDto; admin: boolean; disabled: boolean; now: number }) {
  const [value, setValue] = useState(String(item.maxActiveTurns));
  const [error, setError] = useState('');
  const savingResourceKeys = useEngineConcurrencyStore((state) => state.savingResourceKeys);
  const setSaving = useEngineConcurrencyStore((state) => state.setSaving);
  const upsert = useEngineConcurrencyStore((state) => state.upsertConcurrency);
  const accessDisabled = isConcurrencyControlDisabled(admin ? 'admin' : 'member', item.resourceKey, savingResourceKeys);
  const presentation = getEngineConcurrencyPresentation(item, now);
  const isSaving = savingResourceKeys.includes(item.resourceKey);
  useEffect(() => setValue(String(item.maxActiveTurns)), [item.maxActiveTurns]);
  const adjust = (amount: number) => { const current = Number(value); setValue(String(Math.min(32, Math.max(1, (Number.isFinite(current) ? current : item.maxActiveTurns) + amount)))); setError(''); };
  const save = async () => {
    const validation = validateMaxActiveTurns(value);
    if (validation.error) { setError(validation.error); return; }
    setError(''); setSaving(item.resourceKey, true);
    try { const result = await persistEngineConcurrencySetting(item.resourceKey, value, updateEngineConcurrency); if (result.item) upsert(result.item); if (result.error) setError(result.error); }
    finally { setSaving(item.resourceKey, false); }
  };
  return <div className="py-3 first:pt-0 last:pb-0">
    <div className="flex items-start justify-between gap-3"><h4 className="text-xs font-semibold text-[var(--color-text)]">{item.label}</h4>{presentation.availabilityLabel !== '可调度' && <span className={`rounded-full px-2 py-1 text-[11px] ${presentation.tone === 'warning' ? 'bg-[var(--color-notice-attention-bg)] text-[var(--color-status-warning)]' : 'bg-[var(--color-notice-info-bg)] text-[var(--color-status-processing)]'}`}>{presentation.availabilityLabel}</span>}</div>
    <dl className="mt-3 grid grid-cols-2 gap-4 text-xs"><div><dt className="text-[var(--color-text-tertiary)]">当前活动</dt><dd className="mt-1 text-base font-semibold text-[var(--color-text)]">{item.activeTurns} / {item.maxActiveTurns}</dd></div><div><dt className="text-[var(--color-text-tertiary)]">等待队列</dt><dd className={`mt-1 text-base font-semibold ${item.queuedTurns > 0 ? 'text-[var(--color-status-warning)]' : 'text-[var(--color-text)]'}`}>{presentation.queueLabel}</dd></div></dl>
    {admin && <div className="mt-3"><span className="text-xs text-[var(--color-text-secondary)]">最大并发</span>
      <div className="mt-1 flex items-center gap-2"><button type="button" aria-label="减少最大并发" disabled={disabled || accessDisabled || Number(value) <= 1} onClick={() => adjust(-1)} className="engine-maintenance-control min-h-11 min-w-11 rounded-lg text-lg disabled:opacity-40 lg:hidden">−</button><input aria-label="最大并发" type="number" min={1} max={32} value={value} disabled={disabled || accessDisabled} enterKeyHint="done" onChange={(event) => setValue(event.target.value)} className="engine-maintenance-control min-h-11 min-w-0 flex-1 rounded-lg px-3 text-center text-sm disabled:opacity-60 lg:min-h-10 lg:text-left" /><button type="button" aria-label="增加最大并发" disabled={disabled || accessDisabled || Number(value) >= 32} onClick={() => adjust(1)} className="engine-maintenance-control min-h-11 min-w-11 rounded-lg text-lg disabled:opacity-40 lg:hidden">＋</button><button type="button" disabled={disabled || accessDisabled || value === String(item.maxActiveTurns)} onClick={() => void save()} className="engine-maintenance-primary min-h-11 rounded-lg px-3 text-xs font-semibold disabled:opacity-45 lg:min-h-10">{isSaving ? '保存中…' : '保存'}</button></div>
    </div>}
    {error && <p role="alert" className="mt-2 text-xs text-[var(--color-status-danger)]"><FailureNotice error={error} /></p>}
    <CapacityWindow item={item} defaultOpen={item.queuedTurns > 0 || presentation.availabilityLabel !== '可调度'} />
  </div>;
}

export default function EngineConcurrencySection({ engineId, admin, disabled }: { engineId: EngineId; admin: boolean; disabled: boolean }) {
  const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [now, setNow] = useState(Date.now);
  const concurrencyByResourceKey = useEngineConcurrencyStore((state) => state.concurrencyByResourceKey); const replace = useEngineConcurrencyStore((state) => state.replaceConcurrencySnapshot);
  const items = useMemo(() => filterEngineConcurrencyItems(concurrencyByResourceKey, engineId), [concurrencyByResourceKey, engineId]);
  useEffect(() => { const controller = new AbortController(); setLoading(true); setError(''); getEngineConcurrency(controller.signal).then(replace).catch((reason) => { if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '读取运行容量失败'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [replace]);
  useEffect(() => { const delay = getNextCooldownRefreshDelay(items, now, Date.now()); if (delay === null) return; const timer = globalThis.setTimeout(() => setNow(Date.now()), delay); return () => globalThis.clearTimeout(timer); }, [items, now]);
  return <section className="theme-surface engine-maintenance-card"><h3 className="text-sm font-semibold text-[var(--color-text)]">运行容量</h3><div className="mt-3 divide-y divide-[var(--color-border-light)]">{error && <div role="alert" className="rounded-lg border border-[var(--color-status-danger)]/35 px-3 py-2 text-xs text-[var(--color-status-danger)]"><FailureNotice error={error} /></div>}{loading && items.length === 0 ? <p className="py-5 text-center text-sm text-[var(--color-text-secondary)]">正在读取运行容量…</p> : items.map((item) => <ConcurrencyResource key={item.resourceKey} item={item} admin={admin} disabled={disabled} now={now} />)}{!loading && !error && items.length === 0 && <p className="py-5 text-center text-sm text-[var(--color-text-secondary)]">暂无运行容量信息</p>}</div></section>;
}
