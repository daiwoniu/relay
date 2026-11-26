import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { featureAction, useSearchCommit } from '../../analytics/features';
import { tracker } from '../../analytics/tracker';
import { useAuth } from '../../auth/AuthContext';
import { useChinaDayGreeting } from '../../hooks/useChinaDayGreeting';
import { useTheme } from '../../hooks/useTheme';
import { nextThemePreference } from '../../theme/theme-model';
import { getDeviceId } from '../../utils/device-id';
import { isMediaToolId } from '../../../../server/src/analytics/registry.ts';
import RelayLogo from '../brand/RelayLogo';
import ConfirmDialog from '../ui/ConfirmDialog';
import FailureNotice from '../ui/FailureNotice';
import { ToolGuide, ToolName } from './ToolGuide';
import ToolIcon from './ToolIcon';
import { listTools, toolsCatalog, type ToolSort } from './tools-catalog';
import { toolsStorageKey, type LocalToolId, type ToolId } from './tools-state';
import { scheduleToolUse } from './tools-usage';
import { useToolsSettings } from './useToolsSettings';
import './tools-page.css';

const CalendarPanel = lazy(() => import('../workspace-console/WorkspaceDayPanels').then(module => ({ default: module.WorkspaceCalendarPanel })));
const WeatherPanel = lazy(() => import('../workspace-console/WorkspaceDayPanels').then(module => ({ default: module.WorkspaceWeatherPanel })));
const LocalTools = lazy(() => import('./LocalTools'));
const GreetingTool = lazy(() => import('./LocalTools').then(module => ({ default: module.GreetingTool })));
const MediaTools = lazy(() => import('./media/MediaTools'));
const loginUrl = '/?next=/tools';
type InlineToolId = Exclude<ToolId, 'news'>;
type Destination = InlineToolId | 'login' | null;
type Origin = { id: InlineToolId; top: number; offset: number };

function useToolVisit(id: InlineToolId | null, record: (id: ToolId) => void) {
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
  const navigate = useNavigate();
  const { preference, effectiveTheme, cycleTheme } = useTheme();
  const { today, greeting, rotateGreeting } = useChinaDayGreeting();
  const { state, usageAtLoad, ready, error, saving, change, retry } = useToolsSettings(storageKey, signedIn);
  const [wide, setWide] = useState(() => {
    try { return localStorage.getItem('relay:tools:wide') === 'true'; } catch { return false; }
  });
  const [sort, setSort] = useState<ToolSort>('category');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<InlineToolId | null>(null);
  const [pending, setPending] = useState<{ destination: Destination; origin?: Origin } | null>(null);
  const [jobs] = useState(() => new Set<AbortController>());
  const scroll = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const workspace = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const origin = useRef<Origin | null>(null);
  const pinFocus = useRef<{ id: ToolId; pinned: boolean } | null>(null);
  const commitSearch = useSearchCommit('tools', 'tools');
  const listing = listTools(sort, query, state.pinned, usageAtLoad ?? {});
  const themeLabel = preference === 'system' ? '跟随系统' : effectiveTheme === 'dark' ? '深色' : '浅色';
  const syncLabel = checking ? '正在确认登录…' : !signedIn ? '无需登录 · 置顶与常用保存在当前客户端'
    : saving ? '正在同步…' : error ? '' : ready ? '置顶与常用跨设备同步' : '正在读取账号配置…';
  const focusWorkspace = useCallback(() => {
    workspace.current?.scrollIntoView({ block: 'start' });
    title.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const previous = document.title;
    document.title = '工具集 · Relay';
    return () => { document.title = previous; };
  }, []);

  useLayoutEffect(() => {
    if (active) {
      focusWorkspace();
      return;
    }
    const previous = origin.current;
    const viewport = scroll.current;
    if (!previous || !viewport) return;
    origin.current = null;
    const trigger = viewport.querySelector<HTMLElement>('[data-tool-id="' + previous.id + '"]');
    viewport.scrollTop = trigger
      ? viewport.scrollTop + trigger.getBoundingClientRect().top - viewport.getBoundingClientRect().top - previous.offset
      : previous.top;
    if (!trigger && search.current) search.current.scrollIntoView({ block: 'nearest' });
    (trigger ?? search.current)?.focus({ preventScroll: true });
  }, [active, focusWorkspace]);

  useLayoutEffect(() => {
    const target = pinFocus.current;
    if (!target) return;
    if (state.pinned.includes(target.id) !== target.pinned) {
      if (!saving) pinFocus.current = null;
      return;
    }
    pinFocus.current = null;
    if (document.activeElement === document.body) {
      scroll.current?.querySelector<HTMLButtonElement>('[data-tools-pin="' + target.id + '"]')?.focus();
    }
  }, [state.pinned, saving]);

  useToolVisit(active, id => change({ action: 'use', toolId: id }));

  function toggleWide() {
    featureAction('layout', 'toggle_wide', 'header');
    const next = !wide;
    setWide(next);
    try { localStorage.setItem('relay:tools:wide', String(next)); } catch { /* Use the current page preference. */ }
  }

  function recordOpen(id: ToolId) {
    tracker.track('tool_open', { toolId: id });
    if (id === 'news') change({ action: 'use', toolId: id });
  }

  function transition(destination: Destination, from?: Origin) {
    if (destination === 'login' || destination === null) {
      if (active) tracker.action({ feature: 'tools', action: 'close', surface: 'tools', toolId: active });
      if (destination === 'login') void navigate(loginUrl);
      else setActive(null);
      return;
    }
    if (from) origin.current = from;
    recordOpen(destination);
    setActive(destination);
  }

  function requestTransition(destination: Destination, from?: Origin) {
    if (destination === active) {
      focusWorkspace();
    } else if ([...jobs].some(job => !job.signal.aborted)) {
      setPending({ destination, origin: from });
    } else {
      transition(destination, from);
    }
  }

  function openTool(id: InlineToolId, event: MouseEvent<HTMLButtonElement>) {
    const viewport = scroll.current;
    requestTransition(id, viewport ? {
      id,
      top: viewport.scrollTop,
      offset: event.currentTarget.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
    } : undefined);
  }

  function changeSort(value: ToolSort) {
    if (value === sort) return;
    featureAction('tools', 'filter', 'tools');
    setSort(value);
  }

  function pinButton(id: ToolId) {
    const isPinned = state.pinned.includes(id);
    const unavailable = checking || !ready || saving;
    return <button type="button" className="tools-pin" data-tools-pin={id} aria-label={'置顶' + toolsCatalog[id].title}
      title={isPinned ? '取消置顶' : '置顶'} aria-pressed={isPinned} aria-disabled={unavailable}
      onClick={event => {
        if (unavailable) return;
        if (event.currentTarget === document.activeElement) pinFocus.current = { id, pinned: !isPinned };
        change({ action: 'pin', toolId: id, pinned: !isPinned });
      }}>
      <span aria-hidden="true">{isPinned ? '★' : '☆'}</span>
    </button>;
  }

  function renderRows(ids: readonly ToolId[], compact = false) {
    return <ul className={compact ? 'tools-rows tools-rows-compact' : 'tools-rows'}>
      {ids.map(id => {
        const tool = toolsCatalog[id];
        const content = <>
          <span className="tools-icon"><ToolIcon id={id} /></span>
          <span className="tools-row-copy"><strong><ToolName tool={tool} /></strong>{!compact && <span className="tools-description">{tool.description}</span>}</span>
          {id === 'news' && <span aria-hidden="true" className="tools-external">↗</span>}
        </>;
        return <li key={id} className={id === 'news' ? 'tools-row tools-row-news' : 'tools-row'} data-current={active === id || undefined}>
          <div className="tools-row-actions">
            {id === 'news'
              ? <Link className="tools-entry" to="/news" target="_blank" rel="noopener noreferrer" aria-label={tool.title + '（在新标签页打开）'}
                onClick={() => recordOpen(id)}>{content}</Link>
              : <button className="tools-entry" type="button" data-tool-id={id} aria-expanded={active === id}
                aria-controls={active === id ? 'tools-workspace' : undefined} onClick={event => openTool(id, event)}>{content}</button>}
            {active !== id && pinButton(id)}
          </div>
          {id === 'news' && <ToolGuide id={id} compact />}
        </li>;
      })}
    </ul>;
  }

  const media = active !== null && isMediaToolId(active);
  const wideTool = media || active === 'qr' || active === 'diff' || active === 'json' || active === 'calendar' || active === 'weather';
  return <div ref={scroll} className="tools-page" data-theme={effectiveTheme} data-wide={wide || undefined}>
    <header className="tools-header">
      <div className="tools-frame tools-header-inner">
        <div className="tools-brand"><RelayLogo className="h-7 w-7" />Relay</div>
        <nav className="tools-settings" aria-label="工具集显示设置">
          <button type="button" className="tools-control" onClick={() => {
            tracker.action({ feature: 'tools', action: 'change_theme', surface: 'tools', mode: nextThemePreference(preference) });
            cycleTheme();
          }}
            aria-label={'当前主题：' + (preference === 'system' ? themeLabel + '（' + (effectiveTheme === 'dark' ? '深色' : '浅色') + '）' : themeLabel) + '，点击切换'}>{themeLabel}</button>
          <button type="button" className="tools-control tools-width" onClick={toggleWide} aria-pressed={wide}>宽屏</button>
          {!signedIn && !checking && <Link to={loginUrl} className="tools-control" onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            event.preventDefault();
            requestTransition('login');
          }}>登录</Link>}
        </nav>
      </div>
    </header>
    <main className="tools-frame tools-main">
      <div className="tools-intro"><h1>工具集</h1>{syncLabel && <p role="status">{syncLabel}</p>}</div>
      {error && <div className="tools-sync-error" role="status">
        <FailureNotice error={error} />{signedIn && <button type="button" onClick={retry} className="tools-control">重试同步</button>}
      </div>}

      {active && <section ref={workspace} className="tools-workspace" id="tools-workspace" aria-labelledby="tools-workspace-title" data-wide-tool={wideTool || undefined}>
        <header className="tools-workspace-header">
          <button ref={back} type="button" className="tools-control" onClick={() => requestTransition(null)}>← 返回目录</button>
          <div className="tools-workspace-actions">
            <button type="button" className="tools-control" onClick={() => {
              search.current?.scrollIntoView({ block: 'start' });
              search.current?.focus({ preventScroll: true });
            }}>找工具</button>
            {pinButton(active)}
          </div>
        </header>
        <h2 ref={title} id="tools-workspace-title" tabIndex={-1}><ToolName tool={toolsCatalog[active]} /></h2>
        {active !== 'calendar' && active !== 'weather' && active !== 'greeting' &&
          <p className="tools-data-note">{media ? '文件在此浏览器处理，生成后可下载。' : '内容仅在当前浏览器本地处理。'}</p>}
        <Suspense fallback={<p role="status">正在打开工具…</p>}>
          {active === 'calendar' ? <CalendarPanel placement="inline" today={today} anchorRef={back} onClose={() => requestTransition(null)} />
            : active === 'weather' ? <WeatherPanel placement="inline" today={today} anchorRef={back} onClose={() => requestTransition(null)} />
            : active === 'greeting' ? <GreetingTool greeting={greeting} onRotate={() => {
                tracker.action({ feature: 'tools', action: 'rotate_greeting', surface: 'tools', toolId: 'greeting' });
                rotateGreeting();
              }} />
            : isMediaToolId(active) ? <MediaTools key={active} id={active} storageKey={storageKey} jobs={jobs} />
            : <LocalTools key={active} id={active as LocalToolId} storageKey={storageKey} />}
        </Suspense>
        <ToolGuide key={active} id={active} />
      </section>}

      <div className="tools-browser">
        <label className="tools-search">
          <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4 4" /></svg>
          <input ref={search} type="search" aria-label="搜索工具" value={query} onChange={event => setQuery(event.target.value)}
            onBlur={() => commitSearch(query)} onKeyDown={event => { if (event.key === 'Enter') commitSearch(query); }}
            placeholder="搜工具名称或用途" enterKeyHint="search" />
        </label>
        {listing.searching ? <section aria-labelledby="tools-results">
          <h2 id="tools-results" className="tools-section-title" aria-live="polite">搜索结果（{listing.results.length}）</h2>
          {listing.results.length > 0 ? renderRows(listing.results) : <p className="tools-empty">没有找到匹配的工具。试试工具名称或用途。</p>}
        </section> : <>
          {listing.pinned.length > 0 && <section aria-labelledby="tools-pinned">
            <h2 id="tools-pinned" className="tools-section-title">已置顶</h2>
            {renderRows(listing.pinned, true)}
          </section>}
          <section aria-labelledby="tools-directory">
            <div className="tools-directory-header">
              <h2 id="tools-directory" className="tools-section-title">工具目录</h2>
              {listing.directory.length > 0 && <button type="button" className="tools-control" aria-pressed={sort === 'frequent'}
                onClick={() => changeSort(sort === 'frequent' ? 'category' : 'frequent')}>常用优先</button>}
            </div>
            {listing.directory.length === 0 ? <p className="tools-empty">所有工具都已置顶。</p>
              : sort === 'frequent' ? renderRows(listing.directory[0].ids)
              : <div className="tools-categories">{listing.directory.map(group => <section key={group.label} aria-label={group.label}>
                <h3>{group.label}</h3>{renderRows(group.ids)}
              </section>)}</div>}
          </section>
        </>}
      </div>
    </main>
    <ConfirmDialog open={pending !== null} tone="warning" title="媒体任务仍在进行"
      description="离开当前工具会取消正在进行的文件处理或录音。" cancelLabel="留在当前工具" confirmLabel="取消任务并离开"
      onCancel={() => setPending(null)} onConfirm={() => {
        if (!pending) return;
        if (active && isMediaToolId(active) && [...jobs].some(job => !job.signal.aborted)) {
          tracker.action({ feature: 'tools', action: 'cancel_job', surface: 'tools', toolId: active });
        }
        jobs.forEach(job => job.abort());
        setPending(null);
        transition(pending.destination, pending.origin);
      }} />
  </div>;
}
