import { formatClockTime, formatDate, formatDateTime } from '../../utils/date-display.ts';
import Tooltip from '../ui/Tooltip';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import FailureNotice from '../ui/FailureNotice';
import { consumeCodexResetCredit, getCodexResourceSnapshot } from '../../api/codex-account';
import type { CodexLocalUsageSnapshot } from '../../api/codex-account';
import type { CodexAccountSnapshotDto } from '../../generated/relay-contracts';
import { formatCodexFetchedAt, formatCodexTokenCount } from '../system/codex-account-presentation';
import { loadWorkspaceCodexResources, readWorkspaceCodexCache, subscribeWorkspaceCodexCache } from './workspace-console-cache';
import { createCodexResetIdempotencyKey } from './codex-reset-key';
import { CODEX_CACHE_TTL_MS } from './workspace-console-cache';
import { canUseCodexReset, snapshotNotice } from './workspace-persistent-snapshot';
import { createWorkspaceIdentityRefreshTracker, createWorkspaceRefreshTracker } from './workspace-refresh-policy';
import { formatCodexResetTitle, formatCodexTaskDuration, projectLocalTokenActivityDays, projectLocalTokenActivitySummary, projectTokenActivityBars, projectTokenActivityDays, projectTokenCalendarLayout, projectTokenCalendarMonthLabels, projectWorkspaceCodexResource, selectTokenActivityInputDays } from './workspace-codex-resource';
import type { TokenActivityMode, TokenActivitySource } from './workspace-codex-resource';

const formatResetExpiry = (expiresAt: number | null) => expiresAt === null ? '到期时间未提供' : `${formatDateTime(expiresAt * 1000)} 到期`;
const formatWindowStart = (startAt: number | null) => startAt === null ? null : `推算开始：${formatDateTime(startAt * 1000)}`;
const formatCompactActivityDate = (date: string | undefined) => formatDate(date, { short: true, fallback: '' });
const accountIdentity = (value: CodexAccountSnapshotDto | null) => value?.status === 'ready'
  ? `${value.authMode}:${value.identityVerified === true}:${value.email?.trim().toLowerCase() ?? ''}` : null;

export default function WorkspaceCodexResourceCard({ userId }: { userId: string }) {
  const detailsId = useId();
  const detailsButton = useRef<HTMLButtonElement>(null);
  const detailsPanel = useRef<HTMLDivElement>(null);
  const resetDialog = useRef<HTMLDialogElement>(null);
  const resetDialogTitleId = useId();
  const resetDialogDescriptionId = useId();
  const lastResetAttempt = useRef<{ creditId?: string; availableCount: number; idempotencyKey: string } | null>(null);
  const activeUserId = useRef(userId);
  activeUserId.current = userId;
  const mounted = useRef(true);
  const resourceMeta = useRef<CodexAccountSnapshotDto['sourceMeta']>(undefined);
  const refreshTracker = useMemo(() => createWorkspaceRefreshTracker(), [userId]);
  const initial = readWorkspaceCodexCache(userId);
  const identityRefresh = useMemo(() => createWorkspaceIdentityRefreshTracker(accountIdentity(readWorkspaceCodexCache(userId).value)), [userId]);
  const [snapshot, setSnapshot] = useState<CodexAccountSnapshotDto | null>(initial.value);
  const [localUsage, setLocalUsage] = useState<CodexLocalUsageSnapshot | null>(null);
  const [localUsageError, setLocalUsageError] = useState(false);
  const [loading, setLoading] = useState(!initial.fresh);
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const [error, setError] = useState<string | null>(null);
  const [attemptedAt, setAttemptedAt] = useState<number | null>(null);
  const [selectedUsageDay, setSelectedUsageDay] = useState<string | null>(null);
  const [activitySource, setActivitySource] = useState<TokenActivitySource>('official');
  const [activityMode, setActivityMode] = useState<TokenActivityMode>('daily');
  const [activityDisplay, setActivityDisplay] = useState<'matrix' | 'bars'>('matrix');
  const [detailTab, setDetailTab] = useState<'limits' | 'usage'>('limits');
  const [resetSelection, setResetSelection] = useState<{ creditId?: string; idempotencyKey: string; title: string; expiresAt: number | null } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<{ text: string; success: boolean } | null>(null);

  useEffect(() => {
    const dialog = resetDialog.current;
    if (!dialog) return;
    if (resetSelection && !dialog.open) dialog.showModal();
    if (!resetSelection && dialog.open) dialog.close();
  }, [resetSelection]);

  useEffect(() => subscribeWorkspaceCodexCache(userId, (value) => {
    identityRefresh.observe(accountIdentity(value));
    setSnapshot(value);
    setError(value.sourceMeta?.state === 'failed_snapshot' ? value.sourceMeta.error : null);
  }, true), [userId]);

  const readResources = () => refreshTracker.track(
    loadWorkspaceCodexResources(userId, () => getCodexResourceSnapshot().then((value) => {
      identityRefresh.received(accountIdentity(value.account));
      return value;
    })),
    (value) => value.account.status !== 'ready' || !!value.localUsageError
      || value.account.sourceMeta?.state === 'failed_snapshot' || value.account.sourceMeta?.state === 'unavailable'
      || !!(value.localUsage && value.localUsage.email.trim().toLowerCase() !== value.account.email?.trim().toLowerCase()),
  ).then((value) => {
    const latest = readWorkspaceCodexCache(userId).value;
    const account = latest && latest.fetchedAt > value.account.fetchedAt ? latest : value.account;
    const sameAccount = value.localUsage?.email.trim().toLowerCase() === account.email?.trim().toLowerCase();
    if (mounted.current && activeUserId.current === userId) {
      resourceMeta.current = account.sourceMeta;
      setLocalUsage((current) => sameAccount && value.localUsage ? value.localUsage
        : current?.email.trim().toLowerCase() === account.email?.trim().toLowerCase() ? current : null);
      setLocalUsageError(!!value.localUsageError || !!(value.localUsage && !sameAccount));
    }
    return account;
  });

  useEffect(() => {
    if (!userId) return;
    let active = true;
    mounted.current = true;
    resourceMeta.current = undefined;
    const cached = readWorkspaceCodexCache(userId);
    setSnapshot(cached.value);
    setLocalUsage(null);
    setLocalUsageError(false);
    setActivitySource('official');
    setSelectedUsageDay(null);
    setError(null);
    setResetSelection(null);
    setResetMessage(null);
    lastResetAttempt.current = null;
    loadingRef.current = true;
    setLoading(true);
    void readResources().then((value) => {
      if (!active) return;
      setAttemptedAt(Date.now());
      setSnapshot((current) => value.status === 'ready' ? value : current ?? value);
      if (value.status !== 'ready') setError(value.errorMessage || '额度暂时不可用');
    }).catch((cause) => {
      if (active) { setAttemptedAt(Date.now()); setError(cause instanceof Error ? cause.message : '额度读取失败'); }
    }).finally(() => { if (active) { loadingRef.current = false; setLoading(false); } });
    return () => { active = false; mounted.current = false; };
  }, [userId]);

  const refresh = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setResetSelection(null);
    setLoading(true); setError(null);
    try {
      const value = await readResources();
      if (!mounted.current || activeUserId.current !== userId) return;
      setAttemptedAt(Date.now());
      setSnapshot((current) => value.status === 'ready' ? value : current ?? value);
      if (value.status !== 'ready') setError(value.errorMessage || '额度暂时不可用');
    } catch (cause) {
      if (!mounted.current || activeUserId.current !== userId) return;
      setAttemptedAt(Date.now());
      setError(cause instanceof Error ? cause.message : '额度读取失败');
    } finally {
      if (mounted.current && activeUserId.current === userId) { loadingRef.current = false; setLoading(false); }
    }
  };
  useEffect(() => {
    if (!loadingRef.current && identityRefresh.take()) void refresh();
  }, [userId, snapshot, loading, identityRefresh]);
  useEffect(() => {
    const refreshDue = () => {
      if (document.visibilityState === 'visible' && !loadingRef.current
        && refreshTracker.reason(resourceMeta.current, CODEX_CACHE_TTL_MS)) void refresh();
    };
    const timer = window.setInterval(refreshDue, 30_000);
    document.addEventListener('visibilitychange', refreshDue);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshDue); };
  }, [userId]);
  const chooseReset = (creditId: string | undefined, title: string, expiresAt: number | null) => {
    if (!canUseCodexReset(snapshot)) return;
    const previous = lastResetAttempt.current;
    const availableCount = view?.manualResets ?? 0;
    const idempotencyKey = previous && previous.creditId === creditId && previous.availableCount === availableCount
      ? previous.idempotencyKey : createCodexResetIdempotencyKey();
    lastResetAttempt.current = { creditId, availableCount, idempotencyKey };
    setResetMessage(null);
    setResetSelection({ creditId, idempotencyKey, title, expiresAt });
  };
  const cancelReset = () => {
    setResetSelection(null);
  };
  const consumeReset = async () => {
    if (!resetSelection || resetting || loading || !canUseCodexReset(snapshot)) return;
    setResetting(true);
    setResetMessage(null);
    try {
      const { outcome } = await consumeCodexResetCredit(resetSelection.idempotencyKey, resetSelection.creditId);
      setResetSelection(null);
      lastResetAttempt.current = null;
      setResetMessage({ success: outcome === 'reset' || outcome === 'alreadyRedeemed', text: {
        reset: '手动重置成功，已请求更新额度。',
        alreadyRedeemed: '本次重置已完成，已请求更新额度。',
        nothingToReset: '当前没有可重置的额度窗口，重置次数未消耗。',
        noCredit: '当前没有可用的手动重置次数。',
      }[outcome] });
      await refresh();
    } catch {
      setResetSelection(null);
      setResetMessage({ success: false, text: '重置结果未确认，请先刷新额度，核对可用次数后再操作。' });
    } finally { setResetting(false); }
  };
  const stale = Boolean(error) && Boolean(snapshot?.status === 'ready') || Boolean(snapshot?.sourceMeta && snapshot.sourceMeta.state !== 'live')
    || Boolean(snapshot && !readWorkspaceCodexCache(userId).fresh);
  const view = snapshot ? projectWorkspaceCodexResource(snapshot, stale) : null;
  const planLabel = snapshot?.authMode === 'apikey' ? 'API Key 模式' : view?.plan && view.plan !== '未提供' ? `${view.plan} 套餐` : '套餐未提供';
  const resetAllowed = canUseCodexReset(snapshot);
  const codexNotice = snapshotNotice('Codex', snapshot?.sourceMeta) ?? error;
  const visibleLocalUsage = !error && snapshot?.identityVerified === true
    && localUsage?.email === snapshot.email?.trim().toLowerCase() ? localUsage : null;
  const localUsageAccountMismatch = Boolean(localUsage && snapshot?.email
    && localUsage.email !== snapshot.email.trim().toLowerCase());
  const localUsageDays = projectLocalTokenActivityDays(visibleLocalUsage?.dailyUsageBuckets ?? []);
  const localUsageSummary = projectLocalTokenActivitySummary(localUsageDays);
  const activitySummary = activitySource === 'official' ? view?.usage : visibleLocalUsage ? localUsageSummary : null;
  const availableManualResets = view?.manualResets ?? 0;
  const needsGenericReset = availableManualResets > (view?.manualResetCredits.filter((credit) => credit.id).length ?? 0);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const activityInputDays = selectTokenActivityInputDays(activitySource, view?.usageDays ?? [], visibleLocalUsage?.dailyUsageBuckets ?? [], today);
  const activityDays = projectTokenActivityDays(activityInputDays, activityMode);
  const activityBars = projectTokenActivityBars(activityDays, activityMode);
  const activityModeLabel = { daily: '每日', weekly: '每周', cumulative: '累计' }[activityMode];
  const activityRangeStart = activityDays[activityDisplay === 'bars' ? Math.max(0, activityDays.length - 30) : 0]?.date;
  const activityRangeEnd = activityDays[activityDays.length - 1]?.date;
  const activityRangeLabel = activityDisplay === 'bars' ? `最近 ${Math.min(30, activityDays.length)} 天${activityMode === 'weekly' ? '涉及的' : ''}${activityModeLabel} Token 活动` : '近一年 Token 活动';
  const activityRangeText = `${activityRangeLabel} · ${activityRangeStart ?? '—'} 至 ${activityRangeEnd ?? '—'}`;
  const selectedDay = activityDays.find((day) => day.date === selectedUsageDay);
  const activityLayout = projectTokenCalendarLayout(activityDays);
  const monthLabels = projectTokenCalendarMonthLabels(activityDays);
  const placeDetails = () => {
    const anchor = detailsButton.current?.getBoundingClientRect();
    if (!anchor || !detailsPanel.current) return;
    const maxHeight = Math.min(window.innerHeight * 0.7, 520);
    detailsPanel.current.style.setProperty('--codex-details-top', `${Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - maxHeight - 12))}px`);
    detailsPanel.current.style.setProperty('--codex-details-right', `${Math.max(12, window.innerWidth - anchor.right)}px`);
  };

  return <section aria-label="Codex 工作资源" className="min-w-0 self-start rounded-2xl border border-violet-300/20 bg-gradient-to-br from-violet-300/[0.10] via-[#192235] to-[#111927] p-3 text-left shadow-lg shadow-black/10">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0"><h2 className="text-xs font-semibold tracking-wide text-violet-100">CODEX 额度 <Tooltip content="当前 Codex 账号套餐" asChild><span className="ml-1 font-normal text-slate-400">{planLabel}</span></Tooltip></h2><Tooltip overflowOnly content={view?.email} asChild><p className="mt-1 truncate text-[11px] text-slate-300">{view ? view.email : loading ? '正在读取账号…' : '未提供账号资料'}</p></Tooltip></div>
      <button type="button" disabled={loading || resetting} onClick={() => void refresh()} className="shrink-0 rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-[11px] text-slate-200 hover:bg-white/10 disabled:opacity-50">{loading ? '读取中' : '刷新'}</button>
    </div>
    <div className={`mt-2 grid gap-2 ${view?.summaryWindows.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
      {view?.summaryWindows.length ? view.summaryWindows.map((window) => <div key={window.key} className="min-w-0 rounded-lg border border-violet-300/20 bg-violet-300/[0.08] p-2"><div className="flex items-center justify-between gap-1"><Tooltip overflowOnly content={window.window} asChild><span className="truncate text-[10px] text-slate-300">{window.window}</span></Tooltip><strong className="shrink-0 text-sm leading-none tabular-nums text-violet-100">{window.remaining}%</strong></div><div role="meter" aria-label={`Codex ${window.window}剩余额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remaining} aria-valuetext={`剩余 ${window.remaining}%`} className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-violet-400 to-cyan-300" style={{ width: `${window.remaining}%` }} /></div><Tooltip overflowOnly={Boolean(window.reset)} content={window.reset || '自动重置时间未提供'} asChild><p className="mt-1 truncate text-[10px] text-slate-400">{window.reset || '重置时间未提供'}</p></Tooltip></div>) : <p className="col-span-2 rounded-lg border border-white/10 bg-white/5 p-2 text-[11px] text-slate-400">{snapshot?.authMode === 'apikey' ? 'API Key 模式不提供订阅额度' : loading ? '正在读取额度…' : '额度窗口未提供'}</p>}
    </div>
    <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t border-white/10 pt-2"><p className="text-[10px] text-slate-500">{view ? snapshot?.sourceMeta?.state === 'snapshot' ? `上次同步于 ${formatDateTime(view.fetchedAt, { seconds: true })}` : `${formatCodexFetchedAt(view.fetchedAt)}${view.stale ? ' · 旧数据' : ''}` : attemptedAt ? `读取于 ${formatClockTime(attemptedAt, { seconds: true })}` : '尚未读取'}</p>{view && <button ref={detailsButton} type="button" popoverTarget={detailsId} onClick={placeDetails} className="text-[11px] font-medium text-cyan-200 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">额度与用量详情 →</button>}</div>
    {codexNotice && <p role="status" className="mt-2 text-[11px] text-amber-200">{error ? <FailureNotice error={error} /> : codexNotice} <button type="button" onClick={() => void refresh()} className="underline underline-offset-2">重试</button></p>}
    {view && <div id={detailsId} ref={detailsPanel} popover="auto" role="region" aria-label="Codex 额度与用量详情" className="fixed inset-x-3 bottom-3 top-auto m-0 max-h-[min(78vh,640px)] w-[calc(100vw-1.5rem)] max-w-none overflow-y-auto rounded-2xl border border-violet-300/25 bg-slate-900 p-4 text-xs text-slate-200 shadow-2xl shadow-black/60 lg:inset-x-auto lg:bottom-auto lg:top-[var(--codex-details-top)] lg:right-[var(--codex-details-right)] lg:w-[min(820px,calc(100vw-2rem))] lg:max-h-[min(70vh,520px)]">
      <div className="sticky top-0 z-10 -mx-4 -mt-4 border-b border-white/10 bg-slate-900 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1"><Tooltip overflowOnly content={view.email} asChild><p className="truncate text-[11px] text-violet-200">当前账号 · {view.email}</p></Tooltip><h3 className="mt-1 text-base font-semibold">Codex 使用情况 <span className="ml-1 text-xs font-normal text-slate-400">{planLabel}</span></h3></div>
          <div className="hidden flex-wrap justify-end gap-1.5 sm:flex">{view.summaryWindows.map((window) => <span key={window.key} className="rounded-md border border-violet-300/20 bg-violet-300/[0.08] px-2 py-1 text-[11px] text-slate-300">{window.window} · 剩余 <strong className="tabular-nums text-violet-100">{window.remaining}%</strong></span>)}{view.manualResets !== null && <span className="rounded-md border border-amber-300/20 bg-amber-300/5 px-2 py-1 text-[11px] text-amber-200">手动重置 {view.manualResets} 次</span>}</div>
          <button type="button" popoverTarget={detailsId} popoverTargetAction="hide" className="shrink-0 rounded-md border border-white/15 px-2 py-1 text-[11px]">关闭</button>
        </div>
        <div className="mt-3 flex gap-2" role="group" aria-label="Codex 详情视图"><button type="button" onClick={() => { setDetailTab('limits'); detailsPanel.current?.scrollTo({ top: 0 }); }} aria-pressed={detailTab === 'limits'} className={`rounded-md border px-3 py-1.5 text-[11px] font-medium ${detailTab === 'limits' ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-200' : 'border-white/10 text-slate-400'}`}>额度与重置</button><button type="button" onClick={() => { setDetailTab('usage'); detailsPanel.current?.scrollTo({ top: 0 }); }} aria-pressed={detailTab === 'usage'} className={`rounded-md border px-3 py-1.5 text-[11px] font-medium ${detailTab === 'usage' ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-200' : 'border-white/10 text-slate-400'}`}>Token 用量</button></div>
      </div>
      <div className="mt-4 space-y-4">
        {detailTab === 'limits' && <>
        <section aria-label="套餐额度" className="space-y-2"><h4 className="font-medium text-slate-100">套餐额度</h4>
          {snapshot?.authMode === 'apikey' && <p className="text-slate-400">API Key 模式不提供 ChatGPT 订阅额度。</p>}
          {view.windows.length ? view.windows.map((window) => <div key={window.key} className="rounded-xl border border-white/10 bg-white/[0.03] p-3"><div className="flex justify-between gap-2"><span>{window.name} · {window.window}</span><span className="shrink-0 font-semibold tabular-nums text-violet-100">剩余 {window.remaining}%</span></div><div role="meter" aria-label={`${window.name} ${window.window} 剩余额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remaining} aria-valuetext={`剩余 ${window.remaining}%`} className="mt-2 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-violet-400 to-cyan-300" style={{ width: `${window.remaining}%` }} /></div><div className="mt-2 flex flex-wrap justify-between gap-2 text-[11px] text-slate-400"><span>已用 {window.used}%</span><span>{window.startAt ? formatWindowStart(window.startAt) : '开始时间未提供'}</span><span>{window.reset || '自动重置时间未提供'}</span>{window.reason && <span className="text-amber-200">{window.reason}</span>}</div></div>) : <p className="text-slate-400">接口未提供额度窗口。</p>}
          {view.windows.some((window) => window.startAt !== null) && <p className="text-[10px] text-slate-500">开始时间按下次重置时间减去窗口时长推算，接口未直接提供。</p>}
        </section>
        {view.manualResets !== null && <section aria-label="手动重置额度" className="border-t border-white/10 pt-4"><div className="flex items-center justify-between gap-2"><h4 className="font-medium text-slate-100">手动重置额度</h4><span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px]">可用 {view.manualResets} 次</span></div>
          {!resetAllowed && <p className="mt-2 text-[11px] text-amber-200">刷新确认当前账号和额度后可使用重置。</p>}
          {view.manualResetCredits.length > 0 && <ol className="mt-2 divide-y divide-white/10 rounded-xl border border-white/10 px-3">{view.manualResetCredits.map((credit, index) => <li key={credit.id ?? index} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2.5"><span className="text-slate-200">{formatCodexResetTitle(credit.title, index)}</span><span className="flex items-center gap-3 text-[11px] text-slate-400">{formatResetExpiry(credit.expiresAt)}{credit.id && availableManualResets > 0 && <button type="button" disabled={loading || resetting || !resetAllowed} onClick={() => chooseReset(credit.id ?? undefined, formatCodexResetTitle(credit.title, index), credit.expiresAt)} className="rounded-md border border-amber-300/30 px-2 py-1 font-medium text-amber-200 hover:bg-amber-300/10 disabled:opacity-50">使用</button>}</span></li>)}</ol>}
          {needsGenericReset && <button type="button" disabled={loading || resetting || !resetAllowed} onClick={() => chooseReset(undefined, '由 Codex 选择的一份可用重置', null)} className="mt-2 rounded-md border border-amber-300/30 px-2.5 py-1.5 text-[11px] font-medium text-amber-200 hover:bg-amber-300/10 disabled:opacity-50">使用一次（系统选择）</button>}
          {view.manualResets > view.manualResetCredits.length && <p className="mt-2 text-[11px] text-slate-500">{view.manualResetCredits.length ? `另外 ${view.manualResets - view.manualResetCredits.length} 次的到期时间未提供。` : '逐次到期时间未提供。'}</p>}
          {resetMessage && <p role="status" className={`mt-2 text-[11px] ${resetMessage.success ? 'text-emerald-200' : 'text-amber-200'}`}>{resetMessage.text}</p>}
        </section>}
        {view.credits && <p className="border-t border-white/10 pt-3 text-slate-300">额外 Credits：{view.credits.unlimited ? '无限' : view.credits.hasCredits ? view.credits.remaining ?? '未提供' : '未启用'}{view.credits.currency ? ` ${view.credits.currency}` : ''}</p>}
        </>}
        {detailTab === 'usage' &&
        <section aria-label="Token 活动" className="border-t border-white/10 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium text-slate-100">Token 活动</h4>
            <div className="flex gap-1" role="group" aria-label="Token 活动数据来源">{([['official', '官方'], ['local', '本机']] as const).map(([source, label]) => <button key={source} type="button" aria-pressed={activitySource === source} onClick={() => { setActivitySource(source); setSelectedUsageDay(null); }} className={`rounded-md px-2.5 py-1 text-[11px] ${activitySource === source ? 'bg-orange-300/20 font-medium text-orange-200' : 'text-slate-400 hover:bg-white/10'}`}>{label}</button>)}</div>
          </div>
          {activitySource === 'local' && visibleLocalUsage?.sourceMeta?.state === 'failed_snapshot' && <p role="status" className="mt-2 text-[11px] text-amber-200">本机用量同步失败，显示{visibleLocalUsage.sourceMeta.lastSuccessAt ? ` ${formatDateTime(visibleLocalUsage.sourceMeta.lastSuccessAt, { seconds: true })} 的` : '上次'}已入库统计。</p>}
          {activitySummary && <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">{([
            ['累计 Token', formatCodexTokenCount(activitySummary.lifetimeTokens), '累计 Token 数'],
            ['峰值 Token', formatCodexTokenCount(activitySummary.peakDailyTokens), '单日峰值 Token 数'],
            ['最长任务用时', formatCodexTaskDuration(activitySummary.longestRunningTurnSec ?? null), '最长任务用时'],
            ['当前连续天数', activitySummary.currentStreakDays == null ? '未提供' : `${activitySummary.currentStreakDays} 天`, '当前连续天数'],
            ['最长连续天数', activitySummary.longestStreakDays == null ? '未提供' : `${activitySummary.longestStreakDays} 天`, '最长连续天数'],
          ] as const).map(([label, value, description]) => <Tooltip overflowOnly={description === label} overflowTarget="[data-usage-label]" key={label} content={description} asChild><div className="min-w-0 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2 text-center"><dt data-usage-label className="text-[10px] text-slate-400">{label}</dt><dd className="mt-1 text-xs font-semibold tabular-nums text-slate-100">{value}</dd></div></Tooltip>)}</dl>}
          {activitySource === 'local' && !visibleLocalUsage ? <p className="mt-3 text-slate-400">{localUsageError ? '本机用量或账号资料暂时无法读取，请刷新重试' : localUsageAccountMismatch ? 'Codex 账号已切换，正在同步账号资料…' : '正在读取本机用量…'}</p> : activityDays.length > 0 ? <div className="mt-4">
            <div className="flex items-center gap-2">
              <div className="flex shrink-0 gap-1" role="group" aria-label="Token 活动统计方式">{([['daily', '每日'], ['weekly', '每周'], ['cumulative', '累计']] as const).map(([mode, label]) => <button key={mode} type="button" aria-label={label} aria-pressed={activityMode === mode} onClick={() => { setActivityMode(mode); setSelectedUsageDay(null); }} className={`rounded-md px-1 py-1 text-[11px] sm:px-2.5 ${activityMode === mode ? 'bg-orange-300/20 font-medium text-orange-200' : 'text-slate-400 hover:bg-white/10'}`}><span className="sm:hidden">{mode === 'daily' ? '日' : mode === 'weekly' ? '周' : '累计'}</span><span className="hidden sm:inline">{label}</span></button>)}</div>
              <Tooltip overflowOnly content={activityRangeText} asChild><p className="min-w-0 flex-1 truncate text-center text-[10px] text-slate-300 sm:text-[11px]"><span className="hidden sm:inline">{activityRangeText}</span><span className="sm:hidden" data-tooltip-truncated={activityRangeText !== `${formatCompactActivityDate(activityRangeStart)}–${formatCompactActivityDate(activityRangeEnd)}` || undefined}>{formatCompactActivityDate(activityRangeStart)}–{formatCompactActivityDate(activityRangeEnd)}</span></p></Tooltip>
              <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Token 活动展示方式">{([['matrix', '方块矩阵'], ['bars', '进度条']] as const).map(([mode, label]) => <button key={mode} type="button" aria-label={label} aria-pressed={activityDisplay === mode} onClick={() => { setActivityDisplay(mode); setSelectedUsageDay(null); }} className={`rounded-md px-1 py-1 text-[11px] sm:px-2.5 ${activityDisplay === mode ? 'bg-orange-300/20 font-medium text-orange-200' : 'text-slate-400 hover:bg-white/10'}`}><span className="sm:hidden">{mode === 'matrix' ? '矩阵' : label}</span><span className="hidden sm:inline">{label}</span></button>)}</div>
            </div>
            {activityDisplay === 'bars' ? <><ol className="mt-3 max-h-80 divide-y divide-white/5 overflow-y-auto pr-1" aria-label={activityRangeText}>{[...activityBars].reverse().map((item) => <Tooltip key={item.date} content={`${item.label}${item.recordedDays === null ? '' : ` · 已记录 ${item.recordedDays} 天`}`} asChild><li className="grid grid-cols-[5.5rem_minmax(0,1fr)_4.5rem] items-center gap-2 py-1.5 text-[11px]"><time dateTime={item.date} className="tabular-nums text-slate-300">{item.date.slice(5)}{activityMode === 'weekly' ? ' 周' : ''}</time><div aria-hidden="true" className={`h-2.5 min-w-0 overflow-hidden rounded-full ${item.value === null ? 'border border-dashed border-white/20 bg-white/5' : 'bg-white/10'}`}>{item.value !== null && <div className="h-full rounded-full bg-gradient-to-r from-amber-400/60 to-orange-300" style={{ width: `${item.percent}%` }} />}</div><span className="text-right tabular-nums text-slate-300">{item.value === null ? '未提供' : formatCodexTokenCount(item.value)}</span></li></Tooltip>)}</ol><Tooltip content={activitySource === 'local' ? '以当前列表最高值为满格；每周合并为一条' : '以当前列表最高值为满格；每周合并为一条；灰框为接口未提供'} asChild><p className="mt-2 truncate text-[10px] text-slate-500">最高值为满格{activitySource === 'official' ? ' · 灰框无数据' : ''}</p></Tooltip></> : <>
            <div className="mt-2 min-w-0" style={{ maxWidth: `${Math.max(32, activityLayout.columns * 16)}px` }}><div className="grid w-full gap-px sm:gap-1" style={{ gridTemplateColumns: `repeat(${activityLayout.columns}, minmax(0, 1fr))` }}>{Array.from({ length: activityLayout.columns }, (_, column) => <div key={column} className="grid min-w-0 grid-rows-7 gap-px rounded-[3px] hover:bg-orange-200/10 hover:ring-1 hover:ring-inset hover:ring-orange-200/70 focus-within:bg-orange-200/10 focus-within:ring-1 focus-within:ring-inset focus-within:ring-orange-200/70 sm:gap-1">{Array.from({ length: 7 }, (_, row) => {
              const index = column * 7 + row - activityLayout.leading;
              if (index < 0) return <span key={row} aria-hidden="true" className="aspect-square w-full" />;
              if (index >= activityDays.length) return <span key={row} aria-hidden="true" className="aspect-square w-full rounded-[2px] border border-dashed border-white/10" />;
              const day = activityDays[index];
              const label = `${day.periodLabel} · ${day.value === null ? '用量未提供' : `${formatCodexTokenCount(day.value)} Token${day.recordedDays === null ? '' : `（已记录 ${day.recordedDays} 天）`}`}`;
              return <Tooltip key={day.date} content={label} asChild><button type="button" onClick={() => setSelectedUsageDay(day.date)} aria-label={label} className={`aspect-square w-full min-w-0 rounded-[2px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-200 ${day.value === null ? 'bg-white/5' : day.level === 0 ? 'bg-white/15' : ['','bg-orange-300/25', 'bg-orange-300/45', 'bg-orange-300/70', 'bg-orange-300'][day.level]}`} /></Tooltip>;
            })}</div>)}</div><div className="relative mt-1 h-4 w-full">{monthLabels.map(({ column, month }) => <span key={column} className="absolute whitespace-nowrap text-[10px] text-slate-500" style={{ left: `${column / activityLayout.columns * 100}%` }}>{month}月</span>)}</div></div>
            <p className="mt-1 text-[11px] text-slate-400">{selectedDay ? `${selectedDay.periodLabel}：${selectedDay.value === null ? '用量未提供' : `${formatCodexTokenCount(selectedDay.value)} Token${selectedDay.recordedDays === null ? '' : `（已记录 ${selectedDay.recordedDays} 天）`}`}` : '选择方块查看用量'}</p>
            <Tooltip content={activitySource === 'local' ? '浅灰为 0；末列空框为未来日期。累计只统计当前展示范围。' : '灰色为接口未提供，浅灰为 0；末列空框为未来日期。累计只统计已返回的记录。'} asChild><p className="mt-1 truncate text-[10px] text-slate-500">{activitySource === 'local' ? '浅灰为 0 · 空框为未来日期' : '灰色无数据 · 浅灰为 0 · 空框为未来日期'}</p></Tooltip>
            </>}
          </div> : <p className="mt-3 text-slate-400">{activitySource === 'local' ? '本机暂无 Token 记录。' : '官方暂无每日 Token 记录。'}</p>}
        </section>
        }
      </div>
      <dialog ref={resetDialog} aria-labelledby={resetDialogTitleId} aria-describedby={resetDialogDescriptionId}
        onCancel={(event) => { event.preventDefault(); if (!resetting) cancelReset(); }}
        className="confirm-dialog confirm-dialog--warning workspace-codex-reset-dialog backdrop:bg-slate-950/75">
        <header className="confirm-dialog__header">
          <div className="confirm-dialog__icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 3.75 21 20.25H3L12 3.75Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><path d="M12 9v5M12 17.25h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></div>
          <div className="min-w-0 flex-1"><div className="confirm-dialog__eyebrow">手动重置额度</div><h2 id={resetDialogTitleId} className="confirm-dialog__title">使用一次重置？</h2></div>
        </header>
        <div id={resetDialogDescriptionId} className="confirm-dialog__body">
          <div className="confirm-dialog__description">确认后将向 Codex 提交这次重置请求。</div>
          {resetSelection && <section className="confirm-dialog__subject" aria-label="本次使用"><div className="confirm-dialog__subject-label">本次使用</div><div className="confirm-dialog__subject-value">{resetSelection.title}</div><div className="confirm-dialog__subject-detail">{formatResetExpiry(resetSelection.expiresAt)}</div></section>}
          <section className="confirm-dialog__impact-section"><div className="confirm-dialog__section-title">影响范围</div><ul className="confirm-dialog__impacts"><li><span aria-hidden="true" /><div>成功后消耗一次保存的重置</div></li><li><span aria-hidden="true" /><div>符合条件的额度窗口及下次重置时间可能改变</div></li></ul></section>
        </div>
        <footer className="confirm-dialog__actions"><button type="button" disabled={resetting} onClick={cancelReset} className="confirm-dialog__button confirm-dialog__button--secondary">取消</button><button type="button" disabled={loading || resetting || !resetAllowed} onClick={() => void consumeReset()} className="confirm-dialog__button confirm-dialog__button--primary">{resetting ? '重置中…' : '确认使用'}</button></footer>
      </dialog>
    </div>}
  </section>;
}
