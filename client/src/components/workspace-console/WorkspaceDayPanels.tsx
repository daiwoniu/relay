import FailureNotice from '../ui/FailureNotice';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { getChinaCalendarMonth, getChinaWeatherRange, type ChinaCalendarMonthData, type ChinaWeatherRangeData } from '../../api/china-day';
import { fitCardPopover, positionDayPopover } from './day-popover-position';
import './tools-day-panels.css';

const weekNames = ['一', '二', '三', '四', '五', '六', '日'];
const years = Array.from({ length: 199 }, (_, index) => index + 1901);

function PanelShell({ title, actions, footer, anchorRef, onClose, children, kind, placement }: {
  title: string; actions: React.ReactNode; footer: React.ReactNode; anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void; children: React.ReactNode; kind: 'calendar' | 'weather';
  placement?: 'card';
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const place = useCallback(() => {
    const panel = panelRef.current;
    const trigger = anchorRef.current;
    const anchor = (placement === 'card' ? trigger?.closest('article') ?? trigger : trigger)?.getBoundingClientRect();
    if (!panel || !anchor) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const size = panel.getBoundingClientRect();
    const position = placement === 'card'
      ? fitCardPopover(anchor, { width: size.width, height: Math.min(panel.scrollHeight + panel.offsetHeight - panel.clientHeight, viewport.height * .78, 720) }, viewport)
      : positionDayPopover(anchor, size, viewport, { horizontal: kind === 'weather' ? 'center' : 'anchor' });
    if ('maxHeight' in position) panel.style.maxHeight = `${Math.min(Number(position.maxHeight), viewport.height * .78, 720)}px`;
    panel.style.left = `${position.left}px`;
    panel.style.top = `${position.top}px`;
  }, [anchorRef, kind, placement]);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const trigger = anchorRef.current;
    panel.showPopover();
    panel.querySelector<HTMLButtonElement>('[data-panel-close]')?.focus({ preventScroll: true });
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    if (trigger) observer.observe(trigger.closest('article') ?? trigger);
    const grid = trigger?.closest('[data-tools-grid]');
    if (grid) observer.observe(grid);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      if (panel.contains(document.activeElement) || document.activeElement === document.body) trigger?.focus({ preventScroll: true });
    };
  }, [anchorRef, place]);
  // Sorting tools can move the trigger without resizing either element.
  useLayoutEffect(place);
  return <div ref={panelRef} data-tools-popover={placement === 'card' ? '' : undefined} popover="auto" role="dialog" aria-label={title} onToggle={(event) => { if (!event.currentTarget.matches(':popover-open')) onClose(); }}
    className="fixed m-0 overflow-y-auto rounded-2xl border border-white/15 bg-slate-950 p-4 text-slate-100 shadow-2xl shadow-black/60 [&_button]:min-h-10 [&_select]:min-h-10 sm:p-5"
    style={{ inset: 'auto', width: kind === 'weather' ? 'min(1560px, calc(100vw - 24px))' : 'min(560px, calc(100vw - 24px))', maxHeight: 'min(78dvh, 720px)' }}>
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{title}</h2><div className="flex flex-wrap items-center justify-end gap-2">{actions}<button data-panel-close type="button" onClick={onClose} className="rounded-lg border border-white/15 px-2.5 py-1.5 text-xs hover:bg-white/10">关闭</button></div></div>
    <div className="mt-4">{children}</div>
    <footer className="mt-4 border-t border-white/10 pt-3 text-[11px] leading-5 text-slate-400">{footer}</footer>
  </div>;
}

function shortLunar(value: string): string {
  return value.replace(/^.*?年/, '');
}

function displayDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${year}年${month}月${day}日 · 星期${['日', '一', '二', '三', '四', '五', '六'][weekday]}`;
}

export function WorkspaceCalendarPanel({ today, anchorRef, onClose, placement }: { today: string; anchorRef: RefObject<HTMLButtonElement | null>; onClose: () => void; placement?: 'card' }) {
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const [month, setMonth] = useState(Number(today.slice(5, 7)));
  const [selectedDate, setSelectedDate] = useState(today);
  const [monthData, setMonthData] = useState<ChinaCalendarMonthData | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const handledRetry = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const forceRefresh = retry !== handledRetry.current;
    handledRetry.current = retry;
    setMonthData(null);
    setFetchedAt(null);
    setLoading(true);
    setError(null);
    void getChinaCalendarMonth(year, month, controller.signal, forceRefresh).then((value) => {
      if (controller.signal.aborted) return;
      setMonthData(value);
      setFetchedAt(value.fetchedAt);
    })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [year, month, retry]);

  const changeMonth = (nextYear: number, nextMonth: number) => {
    if (nextYear < 1901 || nextYear > 2099) return;
    setYear(nextYear);
    setMonth(nextMonth);
    setSelectedDate(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01`);
  };
  const shiftMonth = (delta: number) => {
    const next = new Date(Date.UTC(year, month - 1 + delta, 1));
    changeMonth(next.getUTCFullYear(), next.getUTCMonth() + 1);
  };
  const visible = monthData?.year === year && monthData.month === month ? monthData : null;
  const selected = visible?.days.find((day) => day.date === selectedDate);
  return <PanelShell title="万年历" kind="calendar" placement={placement} anchorRef={anchorRef} onClose={onClose}
    actions={<><button type="button" onClick={() => { changeMonth(Number(today.slice(0, 4)), Number(today.slice(5, 7))); setSelectedDate(today); }} className="rounded-lg border border-white/15 px-2.5 py-1.5 text-xs hover:bg-white/10">回到今天</button><button type="button" onClick={() => setRetry((value) => value + 1)} disabled={loading} className="rounded-lg border border-cyan-300/30 px-2.5 py-1.5 text-xs text-cyan-200 hover:bg-cyan-300/10 disabled:opacity-50">刷新</button></>}
    footer={<>农历与节气：本地历法库 · 放假安排：holiday-cn{fetchedAt && ` · 更新于 ${new Date(fetchedAt).toLocaleString('zh-CN')}`}{visible && ` · ${visible.warnings.length ? '放假安排不完整，24 小时后重查' : '90 天内复用'}`}</>}>
    <div className="grid grid-cols-[38px_minmax(0,1fr)_38px] items-center gap-2">
      <button type="button" onClick={() => shiftMonth(-1)} disabled={year === 1901 && month === 1} aria-label="上个月" className="w-full rounded-lg border border-white/15 py-1.5 text-sm disabled:opacity-40">‹</button>
      <div className="flex min-w-0 items-center justify-center gap-2"><select aria-label="年份" value={year} onChange={(event) => changeMonth(Number(event.target.value), month)} className="min-w-0 rounded-lg border border-white/15 bg-slate-900 px-2 py-1.5 text-sm">{years.map((value) => <option key={value} value={value}>{value} 年</option>)}</select><select aria-label="月份" value={month} onChange={(event) => changeMonth(year, Number(event.target.value))} className="min-w-0 rounded-lg border border-white/15 bg-slate-900 px-2 py-1.5 text-sm">{Array.from({ length: 12 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value} 月</option>)}</select></div>
      <button type="button" onClick={() => shiftMonth(1)} disabled={year === 2099 && month === 12} aria-label="下个月" className="w-full rounded-lg border border-white/15 py-1.5 text-sm disabled:opacity-40">›</button>
    </div>
    {error && <div role="alert" className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/5 p-3 text-xs text-rose-200">月历读取失败：<FailureNotice error={error} /> <button type="button" onClick={() => setRetry((value) => value + 1)} className="ml-2 underline">重试</button></div>}
    {loading && <p className="mt-5 text-sm text-slate-400">正在读取月历…</p>}
    {visible && !loading && <>
      <div className="mt-5 grid grid-cols-7 gap-1 text-center text-xs text-slate-400">{weekNames.map((value) => <span key={value} className="py-2">周{value}</span>)}</div>
      <div className="grid grid-cols-7 gap-1">{visible.days.map((day) => {
        const holiday = day.holidayArrangement;
        const festival = day.solarFestivals[0] || day.lunarFestivals[0];
        const occasion = day.solarTerm || festival || holiday?.name;
        const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay();
        const weekend = (weekday === 0 || weekday === 6) && !holiday;
        const active = day.date === selectedDate;
        const border = active ? 'border-violet-500' : day.date === today ? 'border-cyan-500' : holiday?.isOffDay ? 'border-emerald-300/30' : holiday ? 'border-amber-300/30' : weekend ? 'border-sky-300/25' : 'border-white/10';
        const background = holiday?.isOffDay ? 'bg-emerald-300/10' : holiday ? 'bg-amber-300/10' : weekend ? 'bg-sky-300/[0.07]' : 'bg-white/[0.03]';
        return <button key={day.date} type="button" onClick={() => setSelectedDate(day.date)} aria-label={`${displayDate(day.date)}，农历${shortLunar(day.lunarDate)}${occasion ? `，${occasion}` : ''}${holiday ? holiday.isOffDay ? '，休假' : '，调休上班' : weekend ? '，周末休息' : ''}`} aria-pressed={active} className={`flex aspect-square min-w-0 flex-col items-center justify-center rounded-lg border p-1 text-center text-[11px] leading-tight hover:shadow-sm ${border} ${background} ${day.inMonth ? '' : 'opacity-50'}`}>
          <span className="relative flex w-full justify-center"><strong className={`text-base font-semibold leading-6 ${day.date === today ? 'text-cyan-300' : 'text-slate-100'}`}>{Number(day.date.slice(-2))}</strong>{holiday && <span className={`absolute right-0 top-0 text-[10px] ${holiday.isOffDay ? 'text-emerald-300' : 'text-amber-300'}`}>{holiday.isOffDay ? '休' : '班'}</span>}</span>
          <span className="w-full truncate text-slate-400" title={day.lunarDate}>{shortLunar(day.lunarDate)}</span>
          {occasion && <span className={`w-full truncate ${day.solarTerm ? 'text-violet-300' : festival ? 'text-rose-300' : 'text-emerald-300'}`} title={occasion}>{occasion}</span>}
        </button>;
      })}</div>
      {selected && <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4 text-sm"><p className="font-medium">{displayDate(selected.date)}</p><p className="mt-1 text-slate-300">农历 {selected.lunarDate}</p><div className="mt-2 flex flex-wrap gap-2 text-xs">{selected.solarTerm && <span className="rounded bg-cyan-300/10 px-2 py-1 text-cyan-200">节气 · {selected.solarTerm}</span>}{[...selected.solarFestivals, ...selected.lunarFestivals].map((name) => <span key={name} className="rounded bg-white/10 px-2 py-1">{name}</span>)}{selected.holidayArrangement && <span className={`rounded px-2 py-1 ${selected.holidayArrangement.isOffDay ? 'bg-emerald-300/10 text-emerald-200' : 'bg-amber-300/10 text-amber-200'}`}>{selected.holidayArrangement.name} · {selected.holidayArrangement.isOffDay ? '休假' : '调休上班'}</span>}</div></div>}
      {visible.warnings.length > 0 && <p className="mt-3 text-xs text-amber-200">{visible.warnings.join('；')}，节假日与调休标记可能不完整。</p>}
    </>}
  </PanelShell>;
}

function weatherText(code: number | null): string {
  if (code === null) return '天气待更新';
  if (code === 0) return '晴';
  if (code <= 3) return '多云';
  if (code <= 48) return '雾';
  if (code <= 57) return '毛毛雨';
  if (code <= 67) return '雨';
  if (code <= 77) return '雪';
  if (code <= 82) return '阵雨';
  if (code <= 86) return '阵雪';
  if (code >= 95) return '雷雨';
  return '天气变化';
}

function weatherTile(day: ChinaWeatherRangeData['days'][number]) {
  const [year, month, date] = day.date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return <div key={day.date} data-day-kind={day.kind} aria-label={`${day.kind === 'past' ? '过去' : day.kind === 'today' ? '今天' : '未来'}，${month}月${date}日`} className={`min-w-0 rounded-lg border p-2.5 ${day.kind === 'today' ? 'border-cyan-300/40 bg-cyan-300/10' : day.kind === 'past' ? 'border-slate-400/20 bg-slate-400/[0.07]' : 'border-violet-300/20 bg-violet-300/[0.07]'}`}>
    <p className="whitespace-nowrap text-xs font-medium">{month}月{date}日 · 周{['日', '一', '二', '三', '四', '五', '六'][weekday]}</p>
    <p className="mt-2 text-xs text-slate-300">{weatherText(day.weatherCode)}</p>
    <p className="mt-2 text-sm tabular-nums text-slate-100">{day.lowC === null ? '—' : `${Math.round(day.lowC)}°`} / {day.highC === null ? '—' : `${Math.round(day.highC)}°`}</p>
    <p className="mt-1 text-[11px] text-slate-400">降水 {day.precipitationMm === null ? '—' : `${day.precipitationMm} mm`}</p>
    {day.precipitationProbabilityPercent !== null && <p className="text-[11px] text-slate-400">概率 {day.precipitationProbabilityPercent}%</p>}
  </div>;
}

export function WorkspaceWeatherPanel({ city, today, anchorRef, onClose, placement }: { city?: string; today: string; anchorRef: RefObject<HTMLButtonElement | null>; onClose: () => void; placement?: 'card' }) {
  const daysRef = useRef<HTMLDivElement>(null);
  const [selectedCity, setSelectedCity] = useState<string | undefined>();
  const [cityInput, setCityInput] = useState('');
  const requestedCity = placement === 'card' ? selectedCity : city;
  const [range, setRange] = useState<ChinaWeatherRangeData | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const handledRetry = useRef(0);
  useLayoutEffect(() => {
    const container = daysRef.current;
    const currentDay = container?.querySelector<HTMLElement>('[data-day-kind="today"]');
    if (!container || !currentDay || container.scrollWidth <= container.clientWidth) return;
    const left = currentDay.getBoundingClientRect().left - container.getBoundingClientRect().left + container.scrollLeft;
    container.scrollLeft = Math.max(0, left - (container.clientWidth - currentDay.clientWidth) / 2);
  }, [range, loading]);
  useEffect(() => {
    const controller = new AbortController();
    const forceRefresh = retry !== handledRetry.current;
    handledRetry.current = retry;
    setRange(null);
    setFetchedAt(null);
    setLoading(true);
    setError(null);
    void getChinaWeatherRange(requestedCity, controller.signal, forceRefresh).then((value) => {
      if (controller.signal.aborted) return;
      setRange(value);
      setFetchedAt(value.fetchedAt);
    })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [requestedCity, today, retry]);
  return <PanelShell title={range ? `${range.location.city}最近天气` : '最近天气'} kind="weather" placement={placement} anchorRef={anchorRef} onClose={onClose}
    actions={<button type="button" onClick={() => setRetry((value) => value + 1)} disabled={loading} className="rounded-lg border border-cyan-300/30 px-2.5 py-1.5 text-xs text-cyan-200 hover:bg-cyan-300/10 disabled:opacity-50">刷新</button>}
    footer={<>数据来源：Open-Meteo 逐日预报，过去三天为模型回溯{fetchedAt && ` · 更新于 ${new Date(fetchedAt).toLocaleString('zh-CN')}`} · 5 小时内复用</>}>
    {placement === 'card' && <form onSubmit={(event) => { event.preventDefault(); const next = cityInput.trim(); if (next) setSelectedCity(next); }} className="mb-4 flex flex-wrap items-center gap-2">
      <input aria-label="天气城市" placeholder="输入城市或区县，如酒泉市" maxLength={30} value={cityInput} onChange={(event) => setCityInput(event.target.value)} enterKeyHint="search" className="min-h-10 min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-base sm:max-w-64 sm:text-sm" />
      <button type="submit" disabled={!cityInput.trim()} className="rounded-lg border border-white/15 px-3 py-2 text-xs hover:bg-white/10 disabled:opacity-50">切换城市</button>
      <button type="button" onClick={() => { setCityInput(''); setSelectedCity(undefined); }} disabled={!selectedCity} className="rounded-lg border border-white/15 px-3 py-2 text-xs hover:bg-white/10 disabled:opacity-50">当前地区</button>
      <p className="w-full text-xs text-slate-400">{selectedCity ? `正在查看：${selectedCity}` : '默认按网络 IP 识别当前地区，代理可能影响结果。'}</p>
    </form>}
    {error && <div role="alert" className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/5 p-3 text-xs text-rose-200">天气读取失败：<FailureNotice error={error} /> <button type="button" onClick={() => setRetry((value) => value + 1)} className="ml-2 underline">重试</button></div>}
    {loading && <p className="mt-5 text-sm text-slate-400">正在读取近期天气…</p>}
    {range && !loading && <div ref={daysRef} role="region" aria-label="过去三天、今天和未来七天天气" tabIndex={0} className="overflow-x-auto"><div className="grid min-w-[1224px] grid-cols-11 gap-2">{range.days.map(weatherTile)}</div></div>}
  </PanelShell>;
}
