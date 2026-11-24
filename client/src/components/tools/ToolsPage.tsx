import Tooltip from '../ui/Tooltip';
import {featureAction,useSearchCommit} from '../../analytics/features';
import FailureNotice from '../ui/FailureNotice';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useTheme } from '../../hooks/useTheme';
import { useChinaDayGreeting } from '../../hooks/useChinaDayGreeting';
import { getDeviceId } from '../../utils/device-id';
import RelayLogo from '../brand/RelayLogo';
import { toolsStorageKey, type LocalToolId, type ToolId } from './tools-state';
import { useToolsSettings } from './useToolsSettings';
import ToolsGrid, { ToolsExpansionBridge } from './ToolsGrid';
import { scheduleToolUse } from './tools-usage';
import { tracker } from '../../analytics/tracker';
import { isMediaToolId } from '../../../../server/src/analytics/registry.ts';
import { listTools, toolsCatalog, type ToolFilter } from './tools-catalog';
import { ToolGuide, ToolName } from './ToolGuide';
import ToolIcon from './ToolIcon';
import { formatHelpText } from '../workspace-console/workspace-help-text.ts';

const CalendarPanel = lazy(() => import('../workspace-console/WorkspaceDayPanels').then((module) => ({ default: module.WorkspaceCalendarPanel })));
const WeatherPanel = lazy(() => import('../workspace-console/WorkspaceDayPanels').then((module) => ({ default: module.WorkspaceWeatherPanel })));
const LocalTools = lazy(() => import('./LocalTools'));
const MediaTools = lazy(() => import('./media/MediaTools'));
const control = 'min-h-11 rounded-xl border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] sm:min-h-0';

function useToolVisit(id: ToolId | null, record: (id: ToolId) => void) {
  const latestRecord = useRef(record);
  useEffect(() => { latestRecord.current = record; });
  useEffect(() => {
    if (id) return scheduleToolUse(() => latestRecord.current(id));
  }, [id]);
}

export default function ToolsPage() {
  const { user, status } = useAuth();
  const userId = status === 'authenticated' ? user?.id ?? null : null;
  const storageKey = toolsStorageKey(userId, getDeviceId());
  return <ToolsContent key={storageKey} storageKey={storageKey} signedIn={Boolean(userId)} checking={status === 'loading'} />;
}

function ToolsContent({ storageKey, signedIn, checking }: { storageKey: string; signedIn: boolean; checking: boolean }) {
  const { preference, effectiveTheme, cycleTheme } = useTheme();
  const { today, greeting, rotateGreeting } = useChinaDayGreeting();
  const { state, usageAtLoad, ready, error, saving, change, retry } = useToolsSettings(storageKey, signedIn);
  const [wide, setWide] = useState(() => { try { return localStorage.getItem('relay:tools:wide') === 'true'; } catch { return false; } });
  useEffect(() => {
    const previous = document.title; document.title = '工具集 · Relay';
    return () => { document.title = previous; };
  }, []);
  const toggleWide = () => {featureAction('layout','toggle_wide','header');setWide((value) => { try { localStorage.setItem('relay:tools:wide', String(!value)); } catch { /* Use current page preference. */ } return !value; });};
  const [selectedFilter, setFilter] = useState<ToolFilter | null>(null);
  const [query, setQuery] = useState('');
  const [searchFilter, setSearchFilter] = useState<ToolFilter>('all');
  const commitSearch=useSearchCommit('tools','tools');
  const [inlineTool, setInlineTool] = useState<ToolId | null>(null);
  const calendarRef = useRef<HTMLButtonElement>(null);
  const weatherRef = useRef<HTMLButtonElement>(null);

  const { filter, pinned, remaining, searching, counts, resultCount } = listTools(selectedFilter, query, state.pinned, usageAtLoad ?? {}, searchFilter);
  const searchTitle = `搜索结果（${resultCount}）`;
  const visibleInlineTool = inlineTool && (pinned.includes(inlineTool) || remaining.includes(inlineTool)) ? inlineTool : null;
  useToolVisit(visibleInlineTool, (id) => change({ action: 'use', toolId: id }));
  useEffect(() => {
    if (inlineTool && !visibleInlineTool) setInlineTool(null);
  }, [inlineTool, visibleInlineTool]);

  function open(id: ToolId) {
    if (selectedFilter === null && !searching) setFilter(filter);
    const inline = id !== 'news';
    if (inline && inlineTool === id) { closeInline(); return; }
    tracker.track('tool_open',{toolId:id});
    if (id === 'news') change({ action: 'use', toolId: id });
    if (inline) setInlineTool(id);
  }

  function closeInline() {
    if (!inlineTool) return;
    tracker.action({feature:'tools',action:'close',surface:'tools',toolId:inlineTool});
    document.querySelector<HTMLButtonElement>(`[data-tool-id="${inlineTool}"]`)?.focus({ preventScroll: true });
    setInlineTool(null);
  }

  function browse(value: ToolFilter) {
    if (filter !== value) featureAction('tools', 'filter', 'tools');
    if (searching) setSearchFilter(value);
    else setFilter(value);
  }

  function card(id: ToolId) {
    const tool = toolsCatalog[id];
    const isPinned = state.pinned.includes(id);
    const selected = inlineTool === id;
    const content = <><span className={`mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--color-bg-tertiary)] ${tool.color}`}><ToolIcon id={id} /></span>
      <span className="block text-lg font-semibold"><ToolName tool={tool} /></span><span className="mt-2 block min-h-10 text-sm leading-5 text-[var(--color-text-secondary)]">{tool.description}</span>
      <span className="mt-4 block text-xs text-[var(--color-text-secondary)]">{selected ? '收起 ↑' : id === 'news' ? '打开新闻 ↗' : '打开工具 →'}</span></>;
    return <article key={id} data-selected={selected || undefined} className={`relative border bg-[var(--color-surface)] transition-colors ${selected ? 'tools-card-expanded rounded-t-3xl' : 'rounded-2xl border-[var(--color-border)] hover:border-[var(--color-primary)]'}`}>
      {selected && <ToolsExpansionBridge />}
      {id === 'news' ? <Link to="/news" target="_blank" rel="noopener noreferrer" onClick={() => open(id)} className="block rounded-2xl p-5 focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]">{content}</Link>
        : <button data-tool-id={id} ref={id === 'calendar' ? calendarRef : id === 'weather' ? weatherRef : undefined} type="button" onClick={() => open(id)} aria-expanded={inlineTool === id} aria-controls="tools-inline" className="block w-full rounded-2xl p-5 text-left focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]">{content}</button>}
      <button type="button" disabled={checking || !ready || saving} aria-label={`${isPinned ? '取消置顶' : '置顶'}${tool.title}`} aria-pressed={isPinned} onClick={() => change({ action: 'pin', toolId: id, pinned: !isPinned })} className={`absolute right-3 top-3 min-h-11 rounded-lg px-2.5 py-2 text-xs hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50 ${isPinned ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-secondary)]'}`}>{isPinned ? '★ 已置顶' : '☆ 置顶'}</button>
      {id === 'news' && <ToolGuide id={id} compact />}
    </article>;
  }

  const inlinePanel = inlineTool && <section id="tools-inline" tabIndex={-1} aria-labelledby="tools-inline-title" className="scroll-mt-4 p-4 focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] sm:p-6">
    <div className="mb-4 flex items-center justify-between gap-3"><h2 id="tools-inline-title" className="min-w-0 font-semibold"><ToolName tool={toolsCatalog[inlineTool]} /></h2><button type="button" className={`${control} shrink-0`} onClick={closeInline}>收起</button></div>
    <ToolGuide key={inlineTool} id={inlineTool} />
    {inlineTool === 'calendar' || inlineTool === 'weather' ? <Suspense fallback={<p role="status">正在打开工具…</p>}>
      {inlineTool === 'calendar' ? <CalendarPanel placement="inline" today={today} anchorRef={calendarRef} onClose={closeInline} /> : <WeatherPanel placement="inline" today={today} anchorRef={weatherRef} onClose={closeInline} />}
    </Suspense> : inlineTool === 'greeting' ? <><p aria-live="polite" className="my-7 text-lg leading-8">{greeting}</p><button type="button" className={control} onClick={()=>{tracker.action({feature:'tools',action:'rotate_greeting',surface:'tools',toolId:'greeting'});rotateGreeting();}}>换一句 ↻</button></> : isMediaToolId(inlineTool) ? <>
      <p className="mb-4 text-xs text-[var(--color-text-secondary)]">文件在当前设备处理，导出时直接保存。</p>
      <Suspense fallback={<p role="status">正在打开工具…</p>}><MediaTools key={inlineTool} id={inlineTool} storageKey={storageKey} /></Suspense>
    </> : <>
      <p className="mb-4 text-xs text-[var(--color-text-secondary)]">内容仅在当前浏览器本地处理。</p>
      <Suspense fallback={<p role="status">正在打开工具…</p>}><LocalTools key={inlineTool} id={inlineTool as LocalToolId} storageKey={storageKey} /></Suspense>
    </>}
  </section>;
  const themeLabel = preference === 'system' ? `跟随系统（${effectiveTheme === 'dark' ? '深色' : '浅色'}）` : effectiveTheme === 'dark' ? '深色' : '浅色';
  const widthClass = wide ? 'max-w-none' : 'max-w-5xl';
  return <div className="h-full overflow-y-auto bg-[var(--color-bg)] text-[var(--color-text)]">
    <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]"><div className={`mx-auto flex ${widthClass} flex-wrap items-center justify-between gap-3 px-5 py-4`}>
      <div className="flex items-center gap-2 font-semibold"><RelayLogo className="h-7 w-7 text-[var(--color-brand-mark)]" />Relay <span className="ml-2 border-l border-[var(--color-border)] pl-3 text-sm font-normal">工具集</span></div>
      <nav aria-label="工具集显示设置" className="flex items-center gap-2">
        <Tooltip content={formatHelpText(`当前主题：${themeLabel}；点击切换`)} asChild><button type="button" onClick={cycleTheme} aria-label={`当前主题：${themeLabel}；点击切换`} className={`${control} flex items-center gap-2`}>
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">{preference === 'system' ? <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></> : effectiveTheme === 'dark' ? <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" /> : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>}</svg><span className="hidden sm:inline">{themeLabel}</span>
        </button></Tooltip>
        <button type="button" onClick={toggleWide} aria-pressed={wide} className={`${control} hidden lg:inline-flex`}>{wide ? '收窄布局' : '宽屏布局'}</button>
        {!signedIn && !checking && <Link to="/?next=/tools" className={control}>登录</Link>}
      </nav>
    </div></header>
    <main className={`mx-auto ${widthClass} px-5 py-8 sm:py-12`}>
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">常用工具，随手打开</h1>
      <p className="mt-2 text-xs text-[var(--color-text-secondary)]">{checking ? '正在确认登录状态…' : signedIn ? saving ? '正在同步到账号…' : ready ? '账号常用和置顶 · 多设备同步' : '正在读取账号工具配置…' : '无需登录 · 按当前客户端保存常用和置顶'}</p>
      {error && <p role="status" className="mt-3 text-sm text-amber-600"><FailureNotice error={error} />{signedIn && <button type="button" onClick={retry} className="ml-2 underline">重试同步</button>}</p>}
      {pinned.length > 0 && <section aria-label="置顶工具" className="mt-6">
        <h2 className="mb-3 text-sm font-semibold">置顶工具（{pinned.length}）</h2>
        <ToolsGrid ids={pinned} active={inlineTool} card={card} panel={inlinePanel} />
      </section>}
      <div className="mb-6 mt-6 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="工具筛选">
          {([['all', '全部工具'], ['frequent', '常用工具'], ['media', '图片与影音']] as const).map(([value, label]) => {
            const selected = filter === value;
            return <button type="button" key={value} aria-pressed={selected} onClick={() => browse(value)}
              className={`${control} whitespace-nowrap ${selected ? 'bg-[var(--color-bg-tertiary)] font-medium' : ''}`}>{label}（{counts[value]}）</button>;
          })}
        </div>
        <input type="search" aria-label="搜索工具" onBlur={() => commitSearch(query)} onKeyDown={(event) => { if (event.key === 'Enter') commitSearch(query); }}
          value={query} onChange={(event) => {
            const value = event.target.value;
            setQuery(value);
            if (!value.trim()) setSearchFilter('all');
          }} placeholder="搜工具名称或用途"
          className="w-full min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-base sm:ml-auto sm:w-auto sm:max-w-64 sm:flex-1 sm:text-sm" enterKeyHint="search" />
      </div>
      <section aria-label={searching ? searchTitle : '工具列表'}>
        {searching && <h2 className="mb-3 text-sm font-semibold">{searchTitle}</h2>}
        {remaining.length > 0 && <ToolsGrid ids={remaining} active={inlineTool} card={card} panel={inlinePanel} />}
        {resultCount === 0 && <p className="rounded-2xl border border-dashed border-[var(--color-border)] p-6 text-sm text-[var(--color-text-secondary)]">{searching
          ? (counts.all > 0 ? '当前分类没有匹配的未置顶工具，可以切换分类查看。' : '未置顶的工具中没有匹配结果。')
          : filter === 'frequent' ? '暂无未置顶的常用工具。' : '当前分类的工具都已置顶。'}</p>}
      </section>
    </main>
  </div>;
}
