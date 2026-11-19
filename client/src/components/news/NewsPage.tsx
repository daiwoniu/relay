import { formatDate, formatDateTime } from '../../utils/date-display.ts';
import Tooltip from '../ui/Tooltip';
import FailureNotice from '../ui/FailureNotice';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { NewsPublicEventDto, NewsPublicPageDto, NewsMemberPageDto, NewsPersonalPreferencesDto, NewsPersonalRuleDto } from '../../generated/relay-contracts';
import { useAuth } from '../../auth/AuthContext';
import { getMemberNews, getNewsPreferences, getNewsRuleMatches, getPublicNews, getPublicNewsVersion, saveNewsPreferences, type NewsQuery, type NewsRuleMatchStats } from '../../api/news';
import { newsRefreshDelay, relativeNewsTime } from './news-page-state';
import NewsPreferences, { type NewsRuleOptions } from './NewsPreferences';
import { canTranslateNewsInBrowser, translateNewsInBrowser, type ChineseNewsText } from './news-browser-translation';
import { TOPICS } from './news-topics';
import '../../styles/news.css';
import { tracker } from '../../analytics/tracker';
import {featureAction,localAction} from '../../analytics/features';

const CATEGORIES = [
  ['all', '全部'], ['models_products', '模型与产品'], ['research', '研究'],
  ['open_source', '开源工具'], ['industry', '行业动态'],
] as const;
const ENTITIES = [['all', '所有主体'], ['qwen', '通义千问'], ['deepseek', 'DeepSeek'], ['kimi', 'Kimi'], ['doubao', '豆包'], ['wenxin', '文心'], ['zhipu', '智谱'], ['internlm', '书生·浦语'], ['minimax', 'MiniMax'], ['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['google', 'Google'], ['meta', 'Meta'], ['nvidia', 'NVIDIA'], ['microsoft', 'Microsoft'], ['huggingface', 'Hugging Face'], ['ollama', 'Ollama'], ['vllm', 'vLLM']] as const;
const EVENT_TYPES = [['all', '所有事件'], ['release', '发布'], ['update', '更新'], ['research', '研究']] as const;
const DAY_MS = 86_400_000;
const newsTimeBucket = () => Math.floor(Date.now() / 30_000) * 30_000;

function readableDate(time: number) {
  return `${formatDate(time)} ${new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(time)}`;
}

type NewsDisplayItem = NewsPublicEventDto | NewsMemberPageDto['items'][number];
function categoryLabel(id: string, categories: NewsPublicPageDto['categories'] | undefined): string {
  return categories?.find((entry) => entry.id === id)?.label ?? CATEGORIES.find(([categoryId]) => categoryId === id)?.[1] ?? (id === 'other' ? '其他' : id);
}

function NewsCard({ item, category, authenticated, canTranslate, onFollow, onMute }: { item: NewsDisplayItem; category: string; authenticated: boolean; canTranslate: boolean; onFollow: (item: NewsDisplayItem) => void; onMute: (item: NewsDisplayItem) => void }) {
  const [translation, setTranslation] = useState<ChineseNewsText | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [translationError, setTranslationError] = useState('');
  const translate = async () => {
    if (translating) return;
    setTranslating(true);
    setTranslationError('');
    try { setTranslation(await translateNewsInBrowser(item.title, item.description)); setShowOriginal(false); }
    catch (error) { setTranslationError(error instanceof Error ? error.message : '翻译失败，请稍后重试'); }
    finally { setTranslating(false); }
  };
  const visible = translation && !showOriginal ? translation : item;
  return <article className="news-card">
    <div className="news-card-meta">
      <span>{item.sourceName}</span>
      {item.sourceId.startsWith('social-') && item.originalPublisher && <><span aria-hidden="true">·</span><span>作者 {item.originalPublisher}</span></>}
      <span aria-hidden="true">·</span>
      <Tooltip content={formatDateTime(item.publishedAt, { seconds: true })} asChild><time dateTime={new Date(item.publishedAt).toISOString()}>{relativeNewsTime(item.publishedAt)}</time></Tooltip>
      {item.timeIsFallback && <Tooltip content="来源未提供准确发布时间" asChild><span>时间待核对</span></Tooltip>}
    </div>
    <h3><a href={item.url} target="_blank" rel="noopener noreferrer" onClick={()=>tracker.track('news_click',{newsId:item.id})}>{visible.title}</a></h3>
    {visible.description && <p className="news-card-description">{visible.description}</p>}
    {translation && !showOriginal && <span className="news-translation-note">浏览器本机翻译 · 请以原文为准</span>}
    {translationError && <p className="news-translation-error" role="status"><FailureNotice error={translationError} /></p>}
    <div className="news-card-footer">
      <span className="news-tag news-tag--category">{category}</span>
      {item.topicIds.slice(0, 2).map((tag) => <span className="news-tag" key={tag}>{TOPICS.find(([id]) => id === tag)?.[1] ?? tag}</span>)}
      {item.sources.length > 1 && <details className="news-source-count"><summary>{item.sources.length} 个出处</summary><div>{item.sources.map((source) => <a key={source.id} href={source.url} target="_blank" rel="noopener noreferrer" onClick={()=>tracker.track('news_click',{newsId:source.id})}>{source.sourceName}</a>)}</div></details>}
      {'matchReason' in item && item.matchReason && <span className="news-match-reason">{item.matchReason}</span>}
      {item.language === 'en' && canTranslate && (translation ? <button type="button" onClick={() => setShowOriginal((value) => !value)}>{showOriginal ? '看中文' : '看原文'}</button> : <button type="button" onClick={() => void translate()} disabled={translating}>{translating ? '翻译中…' : '翻成中文'}</button>)}
      {authenticated && <><button type="button" onClick={() => onFollow(item)}>关注相关</button><button type="button" onClick={() => onMute(item)}>不感兴趣</button></>}
      <a className="news-card-open" href={item.url} target="_blank" rel="noopener noreferrer" onClick={()=>tracker.track('news_click',{newsId:item.id})}>读原文 ↗</a>
    </div>
  </article>;
}

export default function NewsPage() {
  const pendingRefreshReport=useRef<ReturnType<typeof localAction>|null>(null);
  const { status, user } = useAuth();
  const [canTranslate, setCanTranslate] = useState(false);
  const [category, setCategory] = useState('all');
  const [topic, setTopic] = useState('all');
  const [entity, setEntity] = useState('all');
  const [eventType, setEventType] = useState('all');
  const [source, setSource] = useState('all');
  const [region, setRegion] = useState<'all' | 'cn' | 'global'>('all');
  const [language, setLanguage] = useState('all');
  const [days, setDays] = useState(2);
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [customRange, setCustomRange] = useState<{ from: number; to: number } | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState<NewsPublicPageDto | NewsMemberPageDto | null>(null);
  const [items, setItems] = useState<NewsDisplayItem[]>([]);
  const [view, setView] = useState<'all' | 'following'>('all');
  const [preferences, setPreferences] = useState<NewsPersonalPreferencesDto | null>(null);
  const [matchStats, setMatchStats] = useState<NewsRuleMatchStats | null>(null);
  const [showPreferences, setShowPreferences] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [newer, setNewer] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(newsTimeBucket);

  useEffect(() => {
    let active = true;
    void canTranslateNewsInBrowser().then((available) => { if (active) setCanTranslate(available); });
    return () => { active = false; };
  }, []);

  const query: NewsQuery = {
    from: days === 0 && customRange ? customRange.from : rangeEnd - (days || 2) * DAY_MS,
    to: days === 0 && customRange ? customRange.to : rangeEnd, limit: 20,
    ...(category !== 'all' ? { category } : {}),
    ...(topic !== 'all' ? { topic } : {}),
    ...(entity !== 'all' ? { entity } : {}),
    ...(eventType !== 'all' ? { eventType } : {}),
    ...(source !== 'all' ? { source } : {}),
    ...(region !== 'all' ? { region } : {}),
    ...(language !== 'all' ? { language } : {}),
    ...(search ? { q: search } : {}),
  };
  const member = status === 'authenticated' && Boolean(user);
  const queryKey = JSON.stringify({ query, member, view: member ? view : 'all', userId: user?.id });
  const activeRequestKey = useRef('');
  useLayoutEffect(() => { activeRequestKey.current = `${queryKey}:${refreshKey}`; }, [queryKey, refreshKey]);

  useEffect(() => {
    if (!member) { setPreferences(null); setView('all'); return; }
    getNewsPreferences().then(setPreferences).catch(() => setPreferences({ rules: [] }));
  }, [member, user?.id]);

  useEffect(() => {
    if (!member || !showPreferences || !preferences) return;
    let active = true;
    setMatchStats(null);
    getNewsRuleMatches().then((stats) => { if (active) setMatchStats(stats); }).catch(() => { if (active) setMatchStats(null); });
    return () => { active = false; };
  }, [member, showPreferences, user?.id, preferences]);

  useEffect(() => {
    const controller = new AbortController();
    const report=pendingRefreshReport.current;pendingRefreshReport.current=null;
    setLoading(true);
    setError('');
    (member ? getMemberNews({ ...query, view }, controller.signal) : getPublicNews(query, controller.signal)).then((result) => {
      report?.(true);setPage(result); setItems(result.items); setNewer(false);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted){report?.('cancelled');return;}
      report?.(false);
      setError(reason instanceof Error ? reason.message : '资讯暂时无法加载');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => {controller.abort();report?.('cancelled');};
  // Query is deliberately serialized to make primitive filter changes the effect dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, refreshKey]);

  useEffect(() => {
    if (!page) return;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const check = () => {
      if (document.hidden) return;
      controller = new AbortController();
      getPublicNewsVersion(controller.signal).then((version) => {
        if (version.version > page.version) setNewer(true);
      }).catch(() => undefined).finally(() => {
        if (!document.hidden) timer = window.setTimeout(check, newsRefreshDelay());
      });
    };
    const visibility = () => {
      if (timer) window.clearTimeout(timer);
      controller?.abort();
      if (!document.hidden) timer = window.setTimeout(check, newsRefreshDelay());
    };
    if (!document.hidden) timer = window.setTimeout(check, newsRefreshDelay());
    document.addEventListener('visibilitychange', visibility);
    return () => {
      if (timer) window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [page?.version]);

  const refresh = useCallback(() => { setRangeEnd(newsTimeBucket()); setRefreshKey((value) => value + 1); }, []);
  const refreshUser=()=>{pendingRefreshReport.current?.('cancelled');pendingRefreshReport.current=localAction('news','refresh','news');refresh();};
  const submitSearch = (event: FormEvent) => { event.preventDefault();if(search!==searchInput.trim().slice(0,120))featureAction('news','search','news');setSearch(searchInput.trim().slice(0, 120)); };
  const applyCustomRange = (event: FormEvent) => {
    event.preventDefault();
    const from = new Date(`${customStart}T00:00:00`).getTime();
    const to = new Date(`${customEnd}T23:59:59.999`).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to - from > 31 * DAY_MS || to > Date.now() + DAY_MS) { setError('自选时间范围最多 31 天，且不能超出未来一天'); return; }
    setError(''); setCustomRange({ from, to }); setDays(0);
  };
  const loadMore = async () => {
    if (!page?.nextCursor || loadingMore) return;
    featureAction('news','load_more','news');const requestKey = activeRequestKey.current;
    setLoadingMore(true);
    try {
      const result = member ? await getMemberNews({ ...query, view, cursor: page.nextCursor }) : await getPublicNews({ ...query, cursor: page.nextCursor });
      if (requestKey !== activeRequestKey.current) return;
      setItems((previous) => [...previous, ...result.items]);
      setPage(result);
    } catch (reason) { if (requestKey === activeRequestKey.current) setError(reason instanceof Error ? reason.message : '加载更多失败'); }
    finally { setLoadingMore(false); }
  };

  const savePreferences = async (next: NewsPersonalPreferencesDto) => {
    setPreferenceBusy(true);
    try { setPreferences(await saveNewsPreferences(next)); refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '偏好保存失败'); }
    finally { setPreferenceBusy(false); }
  };
  const quickRule = (item: NewsDisplayItem, kind: 'follow' | 'mute') => {
    if (!member || !preferences) return;
    const condition = kind === 'follow' && item.topicIds[0] ? { topic: item.topicIds[0] } : { source: item.sourceId };
    const rule: NewsPersonalRuleDto = { id: crypto.randomUUID(), kind, ...condition };
    if (preferences.rules.some((existing) => existing.kind === kind && Object.entries(condition).every(([key, value]) => existing[key as keyof NewsPersonalRuleDto] === value))) return;
    void savePreferences({ rules: [...preferences.rules, rule] });
  };

  const groups = new Map<string, NewsDisplayItem[]>();
  for (const item of items) {
    const key = new Date(item.publishedAt).toDateString();
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const advancedFilterCount = [topic, entity, eventType, source, language].filter((value) => value !== 'all').length;
  const preferenceOptions: NewsRuleOptions = {
    category: (page?.categories ?? CATEGORIES.slice(1).map(([id, label]) => ({ id, label }))).map(({ id, label }) => ({ value: id, label })),
    topic: TOPICS.slice(1).map(([value, label]) => ({ value, label })),
    entity: ENTITIES.slice(1).map(([value, label]) => ({ value, label })),
    source: (page?.sources ?? []).map(({ id, name }) => ({ value: id, label: name })),
    eventType: EVENT_TYPES.slice(1).map(([value, label]) => ({ value, label })),
  };
  return <div className="news-page">
    <header className="news-header">
      <div className="news-header-inner">
        <span className="news-brand">AI 情报</span>
        <nav aria-label="账户">
          <Link to="/tools">工具集</Link>
          {status === 'authenticated' && user ? <><button type="button" onClick={() => {featureAction('news','show_rule_matches','news');setShowPreferences(true);}}>我的设置</button>{user.role === 'admin' && <Link className="news-admin-link" to="/admin/news">管理来源</Link>}</>
            : <Link to="/?next=%2Fnews">登录后设置关注</Link>}
        </nav>
      </div>
    </header>
    <main className="news-main">
      <div className="news-toolbar">
        <div className="news-primary-filters">
          {member && <div className="news-view-tabs" role="group" aria-label="资讯视图"><button type="button" className={view === 'all' ? 'active' : ''} onClick={() => {if(view!=='all')featureAction('news','mode','news');setView('all');}}>全部</button><button type="button" className={view === 'following' ? 'active' : ''} onClick={() => {if(view!=='following')featureAction('news','mode','news');setView('following');}}>我的关注</button></div>}
          <div className="news-view-tabs" role="group" aria-label="资讯地区"><button type="button" className={region === 'all' ? 'active' : ''} onClick={() => {if(region!=='all')featureAction('news','filter','news');setRegion('all');}}>国内外</button><button type="button" className={region === 'cn' ? 'active' : ''} onClick={() => {if(region!=='cn')featureAction('news','filter','news');setRegion('cn');}}>国内</button><button type="button" className={region === 'global' ? 'active' : ''} onClick={() => {if(region!=='global')featureAction('news','filter','news');setRegion('global');}}>海外</button></div>
          <div className="news-category-tabs" role="group" aria-label="资讯分类">
            {([['all', '全部'] as const, ...(page?.categories.length ? page.categories.map((entry) => [entry.id, entry.label] as const) : CATEGORIES.slice(1))]).map(([id, label]) => <button key={id} type="button" className={category === id ? 'active' : ''} onClick={() => {if(category!==id)featureAction('news','filter','news');setCategory(id);}}>{label}</button>)}
          </div>
        </div>
        <div className="news-tools-row">
          <label className="news-select-label">时间 <select value={days} onChange={(event) => { featureAction('news','filter','news');setDays(Number(event.target.value)); setRangeEnd(newsTimeBucket()); }}><option value={1}>最近 24 小时</option><option value={2}>最近 48 小时</option><option value={3}>最近 3 天</option><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option><option value={0}>自选时间</option></select></label>
          <button type="button" className="news-advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}>更多筛选{advancedFilterCount > 0 && <span className="news-filter-count">{advancedFilterCount}</span>}<span aria-hidden="true">⌄</span></button>
          <form className="news-search" onSubmit={submitSearch}><input value={searchInput} maxLength={120} onChange={(event) => setSearchInput(event.target.value)} placeholder="搜标题或摘要" aria-label="搜索资讯" enterKeyHint="search" /><button type="submit">搜索</button></form>
        </div>
        {advancedOpen && <div className="news-advanced-filter-fields">
              <label className="news-select-label">话题 <select value={topic} onChange={(event) => {featureAction('news','filter','news');setTopic(event.target.value);}}>{TOPICS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
              <label className="news-select-label">主体 <select value={entity} onChange={(event) => {featureAction('news','filter','news');setEntity(event.target.value);}}>{ENTITIES.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
              <label className="news-select-label">事件 <select value={eventType} onChange={(event) => {featureAction('news','filter','news');setEventType(event.target.value);}}>{EVENT_TYPES.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
              <label className="news-select-label">来源 <select value={source} onChange={(event) => {featureAction('news','filter','news');setSource(event.target.value);}}><option value="all">所有来源</option>{page?.sources.map((entry) => <option value={entry.id} key={entry.id}>{entry.name}</option>)}</select></label>
              <label className="news-select-label">语言 <select value={language} onChange={(event) => {featureAction('news','filter','news');setLanguage(event.target.value);}}><option value="all">全部</option><option value="zh">中文</option><option value="en">英文</option></select></label>
        </div>}
        {days === 0 && <form className="news-custom-range" onSubmit={applyCustomRange}><label>从 <input type="date" required value={customStart} onChange={(event) => setCustomStart(event.target.value)} /></label><label>到 <input type="date" required value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} /></label><button type="submit">查看历史</button><span>每次最多查 31 天</span></form>}
      </div>
      <div className="news-feed-heading">
        <div><h2>新鲜资讯</h2><p>{page?.lastSuccessAt ? `上次成功更新 ${relativeNewsTime(page.lastSuccessAt)}` : '正在等待首次更新'}{page?.partialFailure ? ' · 部分来源暂时未更新' : ''}</p></div>
        <button type="button" onClick={refreshUser} disabled={loading}>刷新</button>
      </div>
      {newer && <button className="news-newer" type="button" onClick={refreshUser}>有新资讯了，点这里看看 ↑</button>}
      {error && <div className="news-message error" role="alert"><FailureNotice error={error} /> <button type="button" onClick={refreshUser}>重试</button></div>}
      {loading ? <div className="news-message" role="status">正在整理最新资讯…</div> : !items.length ? <div className="news-message">{page?.nextCursor ? <>前面的资讯已被当前规则过滤，后面还有内容。<button type="button" onClick={loadMore} disabled={loadingMore}>{loadingMore ? '继续查找中…' : '继续查找'}</button></> : member && view === 'following' && page && 'hasFollowRules' in page && !page.hasFollowRules ? <>还没有关注规则。<button type="button" onClick={() => {featureAction('news','show_rule_matches','news');setShowPreferences(true);}}>去设置关注</button></> : '这里暂时没有匹配的资讯，换个筛选看看。'}</div> : (
        <div className="news-feed">
          {[...groups.entries()].map(([date, group]) => <section className="news-day" key={date}>
            <h2>{readableDate(group[0]!.publishedAt)}</h2>
            <div className="news-day-list">{group.map((item) => <NewsCard item={item} category={categoryLabel(item.categoryId, page?.categories)} authenticated={member} canTranslate={canTranslate} onFollow={(entry) => quickRule(entry, 'follow')} onMute={(entry) => quickRule(entry, 'mute')} key={item.eventId} />)}</div>
          </section>)}
          {page?.nextCursor && <button className="news-more" type="button" onClick={loadMore} disabled={loadingMore}>{loadingMore ? '加载中…' : '再看一些'}</button>}
        </div>
      )}
    </main>
    {member && showPreferences && preferences && <NewsPreferences preferences={preferences} options={preferenceOptions} matchStats={matchStats} busy={preferenceBusy} onSave={savePreferences} onClose={() => setShowPreferences(false)} />}
  </div>;
}
