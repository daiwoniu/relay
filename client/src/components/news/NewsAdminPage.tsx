import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import FailureNotice from '../ui/FailureNotice';
import type { NewsAdminSourceDto, NewsGlobalPolicyDto, NewsSourceConfigDto } from '../../generated/relay-contracts';
import { addAdminNewsSocialItem, getAdminNewsCategories, getAdminNewsItems, getAdminNewsPolicy, getAdminNewsSources, getAdminNewsStats, previewAdminNewsPolicy, refreshAdminNewsSource, saveAdminNewsCategory, saveAdminNewsCorrection, saveAdminNewsPolicy, saveAdminNewsSource, verifyAdminNewsSource, type NewsAdminItems, type NewsAdminStats, type NewsSocialItemInput } from '../../api/news';
import { TOPICS } from './news-topics';
import { buildRsshubSource, RSSHUB_ROUTE_OPTIONS, type RsshubRoute } from './rsshub-source';
import '../../styles/news.css';
import '../../styles/news-admin.css';

const blankSource: NewsSourceConfigDto = { id: '', name: '', kind: 'rss_atom', url: '', allowedHosts: [], enabled: false, intervalMinutes: 60, categoryId: 'industry', region: 'cn' };
const sourceKindLabels: Record<NewsSourceConfigDto['kind'], string> = { rss_atom: 'RSS / Atom', github_releases: 'GitHub 发布', hacker_news: 'Hacker News' };
const blankPolicy: NewsGlobalPolicyDto = { blockedDomains: [], blockedKeywords: [], blockedUrls: [] };
const toLines = (items: string[]) => items.join('\n');
const fromLines = (raw: string) => [...new Set(raw.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))];

export default function NewsAdminPage() {
  const [sources, setSources] = useState<NewsAdminSourceDto[]>([]);
  const [sourceRegion, setSourceRegion] = useState<'all' | 'cn' | 'global'>('all');
  const [sourceStatus, setSourceStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [source, setSource] = useState<NewsSourceConfigDto>(blankSource);
  const [editing, setEditing] = useState(false);
  const [sourceEditorOpen, setSourceEditorOpen] = useState(false);
  const [policy, setPolicy] = useState<NewsGlobalPolicyDto>(blankPolicy);
  const [preview, setPreview] = useState<{ matches: Array<{ id: string; title: string; reason: string }>; capped: boolean } | null>(null);
  const [stats, setStats] = useState<NewsAdminStats | null>(null);
  const [categories, setCategories] = useState<Array<{ id: string; label: string }>>([]);
  const [categoryId, setCategoryId] = useState('');
  const [categoryLabel, setCategoryLabel] = useState('');
  const [correctionEditor, setCorrectionEditor] = useState<{ itemId: string; mode: 'category' | 'topics'; categoryId: string; topicIds: string[] } | null>(null);
  const [recent, setRecent] = useState<NewsAdminItems['items']>([]);
  const [corrections, setCorrections] = useState<NewsAdminItems['corrections']>([]);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const [storageOpen, setStorageOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [social, setSocial] = useState<Omit<NewsSocialItemInput, 'publishedAt'> & { publishedAt: string }>({ platform: 'wechat', url: '', title: '', description: '', author: '', publishedAt: '' });
  const [rsshub, setRsshub] = useState<{ base: string; route: RsshubRoute; target: string; label: string; intervalMinutes: number }>({ base: 'http://127.0.0.1:1200', route: 'weibo-hot', target: '', label: '', intervalMinutes: 60 });

  const load = async (syncPolicy = false) => {
    const [sourceResult, policyResult, statsResult, categoryResult, recentResult] = await Promise.all([
      getAdminNewsSources(), syncPolicy ? getAdminNewsPolicy() : Promise.resolve(null), getAdminNewsStats(), getAdminNewsCategories(), getAdminNewsItems(),
    ]);
    setSources(sourceResult.sources); if (policyResult) setPolicy(policyResult.policy); setStats(statsResult);
    setCategories(categoryResult.categories); setRecent(recentResult.items); setCorrections(recentResult.corrections);
  };
  useEffect(() => { void load(true).catch((error: unknown) => { setFailure(error); setMessage(error instanceof Error ? error.message : '管理数据加载失败'); }); }, []);
  const run = async (task: () => Promise<unknown>, success: string, reload = true, onSuccess?: () => void) => {
    if (busy) return;
    setBusy(true); setMessage(''); setFailure(null);
    try { await task(); setMessage(success); if (reload) await load(); onSuccess?.(); }
    catch (error) { setFailure(error); setMessage(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const selectSource = (entry: NewsAdminSourceDto) => {
    const { state: _state, totalItemCount: _totalItemCount, ...config } = entry;
    setSource(config); setEditing(true);
    setSourceEditorOpen(true);
  };
  const sourceSubmit = (event: FormEvent) => { event.preventDefault(); void run(() => saveAdminNewsSource(source, editing), '来源已保存', true, () => setSourceEditorOpen(false)); };
  const policyField = (field: keyof NewsGlobalPolicyDto, raw: string) => { setPolicy((previous) => ({ ...previous, [field]: fromLines(raw) })); setPreview(null); };
  const socialSubmit = (event: FormEvent) => {
    event.preventDefault();
    const publishedAt = new Date(social.publishedAt).getTime();
    if (!Number.isFinite(publishedAt)) { setMessage('请填写原帖发布时间'); setFailure('请填写原帖发布时间'); return; }
    void run(() => addAdminNewsSocialItem({ ...social, publishedAt }), '原帖已收录或此前已存在', true,
      () => setSocial({ platform: social.platform, url: '', title: '', description: '', author: '', publishedAt: '' }));
  };
  const rsshubSubmit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const candidate = buildRsshubSource(rsshub.base, rsshub.route, rsshub.target, rsshub.label, rsshub.intervalMinutes);
      if (sources.some((entry) => entry.url === candidate.url)) { setMessage('这个 RSSHub 订阅已存在'); setFailure('这个 RSSHub 订阅已存在'); return; }
      void run(() => saveAdminNewsSource(candidate), 'RSSHub 订阅已启用，后续会定时采集', true,
        () => setRsshub((previous) => ({ ...previous, target: '', label: '' })));
    } catch (error) { setFailure(error); setMessage(error instanceof Error ? error.message : 'RSSHub 订阅配置无效'); }
  };
  const visibleSources = sources.filter((entry) =>
    (sourceRegion === 'all' || (entry.region ?? 'global') === sourceRegion)
    && (sourceStatus === 'all' || entry.enabled === (sourceStatus === 'enabled')));
  return <div className="news-page news-admin-page">
    <header className="news-header"><div className="news-header-inner"><span className="news-brand">AI 情报管理</span><nav><Link to="/news">返回资讯</Link></nav></div></header>
    <main className="news-main">
      {message && <div className="news-admin-message" role={failure ? 'alert' : 'status'}>{failure ? <FailureNotice error={failure} /> : message}</div>}
      <div className="news-admin-overview">
        <div className="news-admin-summary"><span><strong>{sources.filter((entry) => entry.enabled).length}</strong> 个启用来源</span><span><strong>{stats?.scheduler?.active ?? 0}</strong> 个正在采集</span><span><strong>{stats?.storage.itemCount ?? 0}</strong> 条已存资讯</span></div>
        <button type="button" className="news-admin-technical-toggle" aria-expanded={storageOpen} onClick={() => setStorageOpen((open) => !open)}>存储详情 <span aria-hidden="true">⌄</span></button>
      </div>
      {storageOpen && <p className="news-admin-technical">资讯版本 {stats?.status.version ?? 0} · 历史月份 {stats?.storage.shardCount ?? 0} · 数据大小 {(stats?.storage.bytes ?? 0) / 1024 / 1024 < 1 ? '< 1' : ((stats?.storage.bytes ?? 0) / 1024 / 1024).toFixed(1)} MiB{stats?.storage.freeBytes != null ? ` · 磁盘可用 ${(stats.storage.freeBytes / 1024 / 1024 / 1024).toFixed(1)} GiB` : ''}</p>}
      <section className="news-admin-section">
        <div className="news-admin-section-heading"><h2>来源</h2><button onClick={() => { setSource({ ...blankSource, id: `source-${crypto.randomUUID()}` }); setEditing(false); setSourceEditorOpen(true); }} type="button">新增来源</button></div>
        <details className="news-admin-disclosure">
          <summary><span className="news-admin-disclosure-title">RSSHub 社交自动采集</span><span>微博 · 抖音 · 小红书 · 公众号</span></summary>
          <div className="news-admin-disclosure-body">
            <p>订阅账号、关键词或热搜后自动定时采集 AI 相关内容。RSSHub 需自行运行；本机默认地址为 127.0.0.1:1200。公众号路由依赖新榜配置，抖音和小红书路由依赖 Puppeteer，失败原因会显示在来源列表。</p>
            <form className="news-admin-form" onSubmit={rsshubSubmit}>
              <div className="news-admin-grid">
                <label className="wide">RSSHub 地址<input type="url" value={rsshub.base} required onChange={(event) => setRsshub({ ...rsshub, base: event.target.value })} placeholder="http://127.0.0.1:1200"  enterKeyHint="done" /></label>
                <label>订阅类型<select value={rsshub.route} onChange={(event) => setRsshub({ ...rsshub, route: event.target.value as RsshubRoute })}>{RSSHUB_ROUTE_OPTIONS.map((route) => <option key={route.id} value={route.id}>{route.name}</option>)}</select></label>
                {RSSHUB_ROUTE_OPTIONS.find((route) => route.id === rsshub.route)?.needsTarget && <label>账号 ID / 关键词<input value={rsshub.target} required onChange={(event) => setRsshub({ ...rsshub, target: event.target.value })}  enterKeyHint="done" /></label>}
                {RSSHUB_ROUTE_OPTIONS.find((route) => route.id === rsshub.route)?.needsTarget && <label>显示名称（可选）<input value={rsshub.label} onChange={(event) => setRsshub({ ...rsshub, label: event.target.value })}  enterKeyHint="done" /></label>}
                <label>采集间隔（分钟）<input type="number" min="15" max="1440" value={rsshub.intervalMinutes} onChange={(event) => setRsshub({ ...rsshub, intervalMinutes: Number(event.target.value) })}  enterKeyHint="done" /></label>
              </div>
              <div className="news-admin-actions"><button type="submit" disabled={busy}>验证并启用自动采集</button></div>
            </form>
          </div>
        </details>
        <div className="news-admin-source-filters">
          <label>地区<select value={sourceRegion} onChange={(event) => setSourceRegion(event.target.value as typeof sourceRegion)}><option value="all">国内外</option><option value="cn">国内</option><option value="global">海外</option></select></label>
          <label>状态<select value={sourceStatus} onChange={(event) => setSourceStatus(event.target.value as typeof sourceStatus)}><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select></label>
          <span>显示 {visibleSources.length} / {sources.length} 个来源</span>
        </div>
        {sourceEditorOpen && <form className="news-admin-form" onSubmit={sourceSubmit}>
          <h3>{editing ? `编辑 ${source.name}` : '新增 RSS / API 来源'}</h3>
          <div className="news-admin-grid">
            <label>名称<input value={source.name} onChange={(event) => setSource({ ...source, name: event.target.value })} required enterKeyHint="next" /></label>
            <label>类型<select value={source.kind} onChange={(event) => setSource({ ...source, kind: event.target.value as NewsSourceConfigDto['kind'] })}><option value="rss_atom">RSS / Atom</option><option value="github_releases">GitHub Releases</option><option value="hacker_news">Hacker News</option></select></label>
            <label>采集间隔（分钟）<input type="number" min="15" max="1440" value={source.intervalMinutes} onChange={(event) => setSource({ ...source, intervalMinutes: Number(event.target.value) })} enterKeyHint="next" /></label>
            <label className="wide">地址<input type="url" value={source.url} onChange={(event) => { const url = event.target.value; let host = ''; try { host = new URL(url).hostname; } catch { /* 尚未输入完整地址 */ } setSource({ ...source, url, allowedHosts: host ? [host] : source.allowedHosts }); }} required enterKeyHint="next" placeholder="https://example.com/feed.xml" /></label>
            <label className="wide">受信任域名（逗号分隔）<input value={source.allowedHosts.join(', ')} onChange={(event) => setSource({ ...source, allowedHosts: event.target.value.split(',').map((part) => part.trim()).filter(Boolean) })} required enterKeyHint="next" /></label>
            <label>主分类<select value={source.categoryId} onChange={(event) => setSource({ ...source, categoryId: event.target.value })}>{source.categoryId && !categories.some((entry) => entry.id === source.categoryId) && <option value={source.categoryId}>原分类：{source.categoryId}</option>}{categories.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}</select></label>
            <label>来源地区<select value={source.region ?? 'global'} onChange={(event) => setSource({ ...source, region: event.target.value as 'cn' | 'global' })}><option value="cn">国内</option><option value="global">海外</option></select></label>
            <label className="news-admin-checkbox"><input type="checkbox" checked={source.enabled} onChange={(event) => setSource({ ...source, enabled: event.target.checked })} />启用采集</label>
          </div>
          <div className="news-admin-actions"><button type="button" disabled={busy} onClick={() => void run(async () => { const result = await verifyAdminNewsSource(source); if (!result.valid) throw new Error(result.error ?? '验证未通过'); setMessage(`验证通过，解析出 ${result.sampleCount} 条样例`); }, '验证通过', false)}>验证来源</button><button type="submit" disabled={busy}>保存来源</button><button type="button" disabled={busy} onClick={() => setSourceEditorOpen(false)}>取消</button></div>
        </form>}
        <div className="news-admin-source-list">
          {visibleSources.map((entry) => <div key={entry.id} className="news-admin-source">
            <div>
              <strong>{entry.name}</strong>
              <span>{entry.enabled ? '启用' : '停用'} · {entry.region === 'cn' ? '国内' : '海外'} · {sourceKindLabels[entry.kind]} · 每 {entry.intervalMinutes} 分钟</span>
              <small title="上次采集是最近一次采集尝试处理的条目数，失败或内容未变化时为 0；不是一段时间内的新增数">
                {entry.state?.lastCheckedAt == null ? '尚未采集' : `上次采集 ${entry.state.lastFetchedCount ?? 0} 条（单次 · ${new Date(entry.state.lastCheckedAt).toLocaleString('zh-CN')}）`}
                {' · '}总采集 {entry.totalItemCount} 条（累计入库）
              </small>
              {entry.state?.lastError && <small>最近错误：{entry.state.lastError}</small>}
            </div>
            <div className="news-admin-actions"><button type="button" onClick={() => selectSource(entry)}>编辑</button><button type="button" disabled={busy || !entry.enabled} onClick={() => void run(() => refreshAdminNewsSource(entry.id), '已提交采集请求')}>立即采集</button></div>
          </div>)}
          {!visibleSources.length && <p className="news-admin-empty">没有符合筛选条件的来源</p>}
        </div>
      </section>
      <details className="news-admin-section news-admin-disclosure">
        <summary><span className="news-admin-disclosure-title">单条原帖补录（可选）</span><span>公众号 · 小红书 · 抖音 · 快手 · 微博</span></summary>
        <div className="news-admin-disclosure-body">
          <p>仅用于 RSSHub 暂时无法覆盖的单条内容；保留作者与原帖，不转载全文或视频。</p>
          <form className="news-admin-form" onSubmit={socialSubmit}>
            <div className="news-admin-grid">
              <label>平台<select value={social.platform} onChange={(event) => setSocial({ ...social, platform: event.target.value as NewsSocialItemInput['platform'] })}><option value="wechat">微信公众号</option><option value="xiaohongshu">小红书</option><option value="douyin">抖音</option><option value="kuaishou">快手</option><option value="weibo">微博</option></select></label>
              <label>作者 / 账号<input value={social.author} maxLength={120} required onChange={(event) => setSocial({ ...social, author: event.target.value })}  enterKeyHint="done" /></label>
              <label className="wide">公开原帖链接<input type="url" value={social.url} maxLength={2048} required placeholder="https://..." onChange={(event) => setSocial({ ...social, url: event.target.value })}  enterKeyHint="done" /></label>
              <label className="wide">标题<input value={social.title} maxLength={300} required onChange={(event) => setSocial({ ...social, title: event.target.value })}  enterKeyHint="done" /></label>
              <label className="wide">简述（可选）<textarea value={social.description} maxLength={1000} rows={2} onChange={(event) => setSocial({ ...social, description: event.target.value })}  enterKeyHint="done" /></label>
              <label>原帖发布时间<input type="datetime-local" value={social.publishedAt} required onChange={(event) => setSocial({ ...social, publishedAt: event.target.value })} /></label>
            </div>
            <div className="news-admin-actions"><button type="submit" disabled={busy}>收录原帖</button></div>
          </form>
        </div>
      </details>
      <section className="news-admin-section">
        <h2>全站过滤</h2><p>每行一项。规则对历史和新资讯立即生效；预览只看最近 7 天。</p>
        <div className="news-admin-grid">{([['blockedDomains', '屏蔽域名'], ['blockedKeywords', '屏蔽关键词'], ['blockedUrls', '屏蔽链接']] as const).map(([field, label]) => <label key={field}>{label}<textarea rows={5} value={toLines(policy[field])} onChange={(event) => policyField(field, event.target.value)} enterKeyHint="enter" /></label>)}</div>
        <div className="news-admin-actions"><button type="button" disabled={busy} onClick={() => void run(async () => { setPreview(await previewAdminNewsPolicy(policy)); }, '预览已更新', false)}>预览命中</button><button type="button" disabled={busy} onClick={() => void run(() => saveAdminNewsPolicy(policy), '全站规则已保存')}>保存规则</button></div>
        {preview && <div className="news-admin-preview"><strong>命中 {preview.matches.length} 条{preview.capped ? '（最多显示 100 条）' : ''}</strong>{preview.matches.slice(0, 20).map((entry) => <div key={entry.id}>{entry.title} <small>{entry.reason}</small></div>)}</div>}
      </section>
      <details className="news-admin-section news-admin-disclosure"><summary><span className="news-admin-disclosure-title">分类词表</span><span>{categories.length} 个分类</span></summary><div className="news-admin-disclosure-body">
        <div className="news-admin-categories">{categories.map((entry) => <button type="button" key={entry.id} onClick={() => { setCategoryId(entry.id); setCategoryLabel(entry.label); }}>{entry.label}</button>)}<button type="button" onClick={() => { setCategoryId(`category_${crypto.randomUUID().replace(/-/g, '')}`); setCategoryLabel(''); }}>新增分类</button></div>
        {categoryId && <div className="news-admin-category-editor"><label>分类名称<input value={categoryLabel} onChange={(event) => setCategoryLabel(event.target.value)} enterKeyHint="done" placeholder="例如：研究" /></label><button type="button" disabled={busy || !categoryLabel.trim()} onClick={() => void run(() => saveAdminNewsCategory(categoryId, categoryLabel.trim()), '分类已保存', true, () => { setCategoryId(''); setCategoryLabel(''); })}>保存分类</button></div>}
      </div></details>
      <details className="news-admin-section news-admin-disclosure"><summary><span className="news-admin-disclosure-title">最近资讯纠错</span><span>{recent.length} 条待查看</span></summary><div className="news-admin-disclosure-body"><p>隐藏只影响公开展示，原始记录仍保留。</p>
        <div className="news-admin-source-list">
          {recent.map((item) => {
            const editor = correctionEditor?.itemId === item.id ? correctionEditor : null;
            return <div className="news-admin-source" key={item.id}>
              <div><strong>{item.title}</strong><small>{sources.find((entry) => entry.id === item.sourceId)?.name ?? item.sourceId} · {categories.find((entry) => entry.id === (item.correction?.categoryId ?? item.categoryId))?.label ?? item.categoryId}</small></div>
              <div className="news-admin-actions">
                <button type="button" disabled={busy} onClick={() => void run(() => saveAdminNewsCorrection(item.id, { ...(item.correction ?? {}), hidden: !item.correction?.hidden }), item.correction?.hidden ? '已恢复资讯' : '已隐藏资讯')}>{item.correction?.hidden ? '恢复' : '隐藏'}</button>
                <button type="button" disabled={busy} onClick={() => setCorrectionEditor({ itemId: item.id, mode: 'category', categoryId: item.correction?.categoryId ?? item.categoryId, topicIds: [] })}>改分类</button>
                <button type="button" disabled={busy} onClick={() => setCorrectionEditor({ itemId: item.id, mode: 'topics', categoryId: '', topicIds: item.correction?.topicIds ?? [] })}>改主题</button>
              </div>
              {editor && <div className="news-admin-correction-editor">
                {editor.mode === 'category' ? <label>选择分类<select value={editor.categoryId} onChange={(event) => setCorrectionEditor({ ...editor, categoryId: event.target.value })}>{editor.categoryId && !categories.some((entry) => entry.id === editor.categoryId) && <option value={editor.categoryId}>原分类：{editor.categoryId}</option>}{categories.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}</select></label> : <div><div className="news-admin-topic-options">{TOPICS.slice(1).map(([id, label]) => <label key={id}><input type="checkbox" checked={editor.topicIds.includes(id)} onChange={(event) => setCorrectionEditor({ ...editor, topicIds: event.target.checked ? [...editor.topicIds, id] : editor.topicIds.filter((value) => value !== id) })} />{label}</label>)}{editor.topicIds.filter((id) => !TOPICS.some(([known]) => known === id)).map((id) => <label key={id}><input type="checkbox" checked onChange={() => setCorrectionEditor({ ...editor, topicIds: editor.topicIds.filter((value) => value !== id) })} />原主题：{id}</label>)}</div><small>保存后替换此条资讯的主题；不选表示清空。</small></div>}
                <div className="news-admin-actions"><button type="button" disabled={busy || (editor.mode === 'category' && !editor.categoryId)} onClick={() => void run(() => saveAdminNewsCorrection(item.id, editor.mode === 'category' ? { ...(item.correction ?? {}), hidden: Boolean(item.correction?.hidden), categoryId: editor.categoryId } : { ...(item.correction ?? {}), hidden: Boolean(item.correction?.hidden), topicIds: editor.topicIds }), editor.mode === 'category' ? '分类已修正' : '主题已修正', true, () => setCorrectionEditor(null))}>保存修正</button><button type="button" onClick={() => setCorrectionEditor(null)}>取消</button></div>
              </div>}
            </div>;
          })}
          {corrections.filter((entry) => entry.correction.hidden && !recent.some((item) => item.id === entry.itemId)).map((entry) => <div className="news-admin-source" key={entry.itemId}><small>已隐藏 · {entry.itemId}</small><button type="button" disabled={busy} onClick={() => void run(() => saveAdminNewsCorrection(entry.itemId, { ...entry.correction, hidden: false }), '已恢复资讯')}>恢复</button></div>)}
        </div>
      </div></details>
      <details className="news-admin-section news-admin-disclosure"><summary><span className="news-admin-disclosure-title">最近操作</span><span>{stats?.audit.length ?? 0} 条记录</span></summary><div className="news-admin-disclosure-body news-admin-preview">{stats?.audit.map((entry, index) => <div key={`${entry.at}-${index}`}>{new Date(entry.at).toLocaleString('zh-CN')} · {entry.actorId} · {entry.action}</div>)}</div></details>
    </main>
  </div>;
}
