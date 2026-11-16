import Tooltip from '../ui/Tooltip';
import FailureNotice from '../ui/FailureNotice';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useTheme } from '../../hooks/useTheme';
import { useChinaDayGreeting } from '../../hooks/useChinaDayGreeting';
import { getDeviceId } from '../../utils/device-id';
import RelayLogo from '../brand/RelayLogo';
import { toolOrder, toolsStorageKey, LOCAL_TOOL_IDS, type LocalToolId, type ToolId } from './tools-state';
import { useToolsSettings } from './useToolsSettings';
import ToolsGrid from './ToolsGrid';

const CalendarPanel = lazy(() => import('../workspace-console/WorkspaceDayPanels').then((module) => ({ default: module.WorkspaceCalendarPanel })));
const WeatherPanel = lazy(() => import('../workspace-console/WorkspaceDayPanels').then((module) => ({ default: module.WorkspaceWeatherPanel })));
const LocalTools = lazy(() => import('./LocalTools'));
const tools = {
  news: { title: 'AI 情报', description: '追踪 AI 动态、产品发布与行业资讯', mode: '新页面', icon: '↗', color: 'text-violet-500' },
  calendar: { title: '万年历', description: '查农历、节气、节日与放假调休', mode: '弹窗', icon: '▦', color: 'text-amber-500' },
  weather: { title: '天气', description: '查看所在城市近期天气与未来预报', mode: '弹窗', icon: '☀', color: 'text-sky-500' },
  greeting: { title: '随机问候语', description: '随时间、节日和天气，换一句好心情', mode: '展开', icon: '✦', color: 'text-emerald-500' },
  timestamp: { title: '时间戳与时区', description: '日期和时间戳互转，查看各地时间', mode: '展开', icon: '◷', color: 'text-sky-500' },
  json: { title: 'JSON 格式化', description: '排版、压缩与校验，保留长数字原值', mode: '展开', icon: '{}', color: 'text-violet-500' },
  qr: { title: '二维码生成', description: '文字或链接生成二维码，下载图片', mode: '展开', icon: '▦', color: 'text-emerald-500' },
  diff: { title: '文本对比', description: '对照两份文字，找出新增与删除', mode: '展开', icon: '⇄', color: 'text-amber-500' },
  pomodoro: { title: '番茄钟', description: '专注一段时间，记得给自己休息', mode: '展开', icon: '◴', color: 'text-rose-500' },
  units: { title: '单位换算', description: '重量、长度、面积、容量与温度互转', mode: '展开', icon: '⇌', color: 'text-sky-500' },
  dates: { title: '日期助手', description: '算日期间隔、倒数日、周岁与前后日期', mode: '展开', icon: '▤', color: 'text-violet-500' },
  shopping: { title: '购物计算', description: '比较单价，算折扣与满减凑单', mode: '展开', icon: '¥', color: 'text-amber-500' },
  random: { title: '随机选择', description: '今天吃什么、抽签或随机分组', mode: '展开', icon: '⚄', color: 'text-emerald-500' },
};
const control = 'min-h-11 rounded-xl border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] sm:min-h-0';

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
  const toggleWide = () => setWide((value) => { try { localStorage.setItem('relay:tools:wide', String(!value)); } catch { /* Use current page preference. */ } return !value; });
  const [filter, setFilter] = useState<'all' | 'frequent'>('all');
  const [query, setQuery] = useState('');
  const [panel, setPanel] = useState<'calendar' | 'weather' | null>(null);
  const [inlineTool, setInlineTool] = useState<ToolId | null>(null);
  const calendarRef = useRef<HTMLButtonElement>(null);
  const weatherRef = useRef<HTMLButtonElement>(null);

  const matches = (id: ToolId) => `${tools[id].title}${tools[id].description}`.toLowerCase().includes(query.trim().toLowerCase());
  const pinned = state.pinned.filter(matches);
  const remaining = toolOrder(filter, usageAtLoad ?? {})
    .filter((id) => !state.pinned.includes(id) && matches(id));

  function open(id: ToolId) {
    const inline = id === 'greeting' || (LOCAL_TOOL_IDS as readonly string[]).includes(id);
    if (inline && inlineTool === id) { setInlineTool(null); return; }
    change({ action: 'use', toolId: id });
    if (id === 'calendar' || id === 'weather') setPanel(id);
    if (inline) setInlineTool(id);
  }

  function closeInline() {
    if (inlineTool) document.querySelector<HTMLButtonElement>(`[data-tool-id="${inlineTool}"]`)?.focus({ preventScroll: true });
    setInlineTool(null);
  }

  function card(id: ToolId) {
    const tool = tools[id];
    const isPinned = state.pinned.includes(id);
    const selected = inlineTool === id || panel === id;
    const content = <><span aria-hidden="true" className={`mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--color-bg-tertiary)] text-2xl ${tool.color}`}>{tool.icon}</span>
      <span className="block text-lg font-semibold">{tool.title}</span><span className="mt-2 block min-h-10 text-sm leading-5 text-[var(--color-text-secondary)]">{tool.description}</span>
      <span className="mt-4 block text-xs text-[var(--color-text-secondary)]">{inlineTool === id ? '收起 ↑' : `${tool.mode} →`}</span></>;
    return <article key={id} data-selected={selected || undefined} className={`relative rounded-2xl border bg-[var(--color-surface)] transition-colors hover:border-[var(--color-primary)] ${selected ? 'border-[var(--color-primary)] ring-2 ring-[var(--color-primary)]' : 'border-[var(--color-border)]'}`}>
      {id === 'news' ? <Link to="/news" target="_blank" rel="noopener noreferrer" onClick={() => open(id)} className="block rounded-2xl p-5 focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]">{content}</Link>
        : <button data-tool-id={id} ref={id === 'calendar' ? calendarRef : id === 'weather' ? weatherRef : undefined} type="button" onClick={() => open(id)} aria-expanded={id === 'calendar' || id === 'weather' ? panel === id : inlineTool === id} aria-haspopup={id === 'calendar' || id === 'weather' ? 'dialog' : undefined} aria-controls={id !== 'calendar' && id !== 'weather' ? 'tools-inline' : undefined} className="block w-full rounded-2xl p-5 text-left focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]">{content}</button>}
      <button type="button" disabled={checking || !ready || saving} aria-label={`${isPinned ? '取消置顶' : '置顶'}${tool.title}`} aria-pressed={isPinned} onClick={() => change({ action: 'pin', toolId: id, pinned: !isPinned })} className={`absolute right-3 top-3 min-h-11 rounded-lg px-2.5 py-2 text-xs hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50 ${isPinned ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-secondary)]'}`}>{isPinned ? '★ 已置顶' : '☆ 置顶'}</button>
    </article>;
  }

  const inlinePanel = inlineTool && <section id="tools-inline" tabIndex={-1} aria-labelledby="tools-inline-title" className="scroll-mt-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] sm:p-6">
    <div className="mb-5 flex items-center justify-between gap-3"><h2 id="tools-inline-title" className="font-semibold">{tools[inlineTool].title}</h2><button type="button" className={control} onClick={closeInline}>收起</button></div>
    {inlineTool === 'greeting' ? <><p aria-live="polite" className="my-7 text-lg leading-8">{greeting}</p><button type="button" className={control} onClick={rotateGreeting}>换一句 ↻</button></> : <>
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
        <Tooltip content={`当前主题：${themeLabel}；点击切换`} asChild><button type="button" onClick={cycleTheme} aria-label={`当前主题：${themeLabel}；点击切换`} className={`${control} flex items-center gap-2`}>
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">{preference === 'system' ? <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></> : effectiveTheme === 'dark' ? <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" /> : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>}</svg><span className="hidden sm:inline">{themeLabel}</span>
        </button></Tooltip>
        <button type="button" onClick={toggleWide} aria-pressed={wide} className={`${control} hidden lg:inline-flex`}>{wide ? '收窄布局' : '宽屏布局'}</button>
        {!signedIn && !checking && <Link to="/?next=/tools" className={control}>登录</Link>}
      </nav>
    </div></header>
    <main className={`mx-auto ${widthClass} px-5 py-8 sm:py-12`}>
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">常用工具，随手打开</h1>
      <p className="mt-3 text-sm leading-6 text-[var(--color-text-secondary)]">资讯、日历、天气，还有日常效率小工具。</p>
      <p className="mt-2 text-xs text-[var(--color-text-secondary)]">{checking ? '正在确认登录状态…' : signedIn ? saving ? '正在同步到账号…' : ready ? '账号常用和置顶 · 多设备同步' : '正在读取账号工具配置…' : '无需登录 · 按当前客户端保存常用和置顶'}</p>
      {error && <p role="status" className="mt-3 text-sm text-amber-600"><FailureNotice error={error} />{signedIn && <button type="button" onClick={retry} className="ml-2 underline">重试同步</button>}</p>}
      <div className="mb-6 mt-6 flex flex-wrap items-center gap-3"><div className="flex gap-2" role="group" aria-label="工具筛选">{(['all', 'frequent'] as const).map((value) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)} className={`${control} ${filter === value ? 'bg-[var(--color-bg-tertiary)] font-medium' : ''}`}>{value === 'all' ? '全部工具' : '常用工具'}</button>)}</div><input aria-label="搜索工具" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工具…" className="w-full min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-base sm:ml-auto sm:w-auto sm:max-w-64 sm:flex-1 sm:text-sm"  enterKeyHint="done" /></div>
      {pinned.length > 0 && <section aria-label="置顶工具" className="mb-8"><h2 className="mb-3 text-sm font-semibold">置顶工具</h2><ToolsGrid ids={pinned} active={inlineTool} card={card} panel={inlinePanel} /></section>}
      <section aria-label={filter === 'frequent' ? '常用工具' : '全部工具'}><h2 className="mb-3 text-sm font-semibold">{filter === 'frequent' ? '常用工具' : '全部工具'}{filter === 'frequent' && <span className="ml-2 font-normal text-[var(--color-text-secondary)]">刷新页面时更新排序</span>}</h2><ToolsGrid ids={remaining} active={inlineTool} card={card} panel={inlinePanel} />
        {remaining.length === 0 && <p className="rounded-2xl border border-dashed border-[var(--color-border)] p-6 text-sm text-[var(--color-text-secondary)]">{query ? '没有匹配的其他工具。' : filter === 'frequent' ? '打开工具后，会在这里按使用次数排序；已置顶的工具在上方。' : '工具已全部置顶，可从上方打开。'}</p>}
      </section>
    </main>
    <Suspense fallback={<p role="status" className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-xl bg-[var(--color-surface)] px-5 py-3 shadow-lg">正在打开工具…</p>}>
      {panel === 'calendar' && <CalendarPanel placement="card" today={today} anchorRef={calendarRef} onClose={() => setPanel(null)} />}
      {panel === 'weather' && <WeatherPanel placement="card" today={today} anchorRef={weatherRef} onClose={() => setPanel(null)} />}
    </Suspense>
  </div>;
}
