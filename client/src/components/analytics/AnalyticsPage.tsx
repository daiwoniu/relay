import { useEffect,useState } from 'react';
import type { AnalyticsSummary,AnalyticsVisit } from '../../analytics/tracker';
import { useAuth } from '../../auth/AuthContext';
import RelayLogo from '../brand/RelayLogo';
import DailyVisitsChart from './DailyVisitsChart';
import { Distribution,LoadError,MetricCard,Ranking,RecentVisits,SummarySkeleton,ToolsRanking } from './AnalyticsSections';
import { analyticsSourceName,beijingDay,beijingTime,number } from './analytics-presentation';
import { useAnalyticsResource } from './useAnalyticsResource';
import AnalyticsHelp,{analyticsHelp} from './AnalyticsHelp';
import './analytics.css';

export default function AnalyticsPage(){
  const {user}=useAuth();
  const [range,setRange]=useState<'today'|'7d'|'30d'|'all'>('7d'),[excludeAdmin,setExcludeAdmin]=useState(false),[excludeInternal,setExcludeInternal]=useState(false),[refresh,setRefresh]=useState(0);
  const allowed=user?.role==='admin',query=`range=${range}&excludeAdmin=${excludeAdmin}&excludeInternal=${excludeInternal}`;
  const summary=useAnalyticsResource<AnalyticsSummary>(allowed?`/api/admin/analytics/summary?${query}`:null,user?.id??'',refresh);
  const visits=useAnalyticsResource<AnalyticsVisit[]>(allowed?`/api/admin/analytics/visits?${query}`:null,user?.id??'',refresh);
  const data=summary.data,retry=()=>setRefresh(value=>value+1),loading=summary.loading||visits.loading;
  useEffect(()=>{const previous=document.title;document.title='访问统计 · Relay';return()=>{document.title=previous;};},[]);
  if(!allowed)return <p className="p-6">仅管理员可查看统计。</p>;
  const scope=user.id;
  const shownVisitRange=(visits.dataPath?new URLSearchParams(visits.dataPath.split('?')[1]).get('range'):range) as typeof range;
  return <div className="analytics-page">
    <header className="analytics-brandbar"><div><RelayLogo className="h-7 w-7 shrink-0 text-[var(--color-brand-mark)]"/><strong>Relay</strong><span className="analytics-brand-divider"/><span>访问统计</span><span className="analytics-admin-label">管理员</span></div></header>
    <main className="analytics-scroll"><div className="analytics-content">
      <div className="analytics-hero"><div><p className="analytics-eyebrow">站点分析</p><h1>访问概览</h1><p>了解访问来自哪里，以及哪些功能正在被使用。</p></div><div className="analytics-refresh"><span role="status">{summary.loading?(data?'正在更新汇总…':'正在读取汇总…'):summary.error?'汇总更新失败':summary.updatedAt?`更新于 ${beijingTime(summary.updatedAt)}`:'等待数据'}</span><button type="button" className="analytics-button" onClick={retry} disabled={loading}><svg className={loading?'analytics-spinning':''} width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M16 7a6.5 6.5 0 1 0 .3 5M16 3v4h-4" strokeLinecap="round" strokeLinejoin="round"/></svg>{loading?'读取中':'刷新数据'}</button></div></div>
      <div className="analytics-toolbar"><div className="analytics-segment" role="group" aria-label="统计日期">{(['today','7d','30d','all'] as const).map(value=><button key={value} type="button" aria-pressed={range===value} onClick={()=>setRange(value)}>{value==='today'?'今天':value==='7d'?'近 7 天':value==='30d'?'近 30 天':'所有时间'}</button>)}</div><div className="analytics-admin-filter-group"><label className="analytics-admin-filter"><input type="checkbox" checked={excludeAdmin} onChange={event=>setExcludeAdmin(event.target.checked)}/>排除已识别管理员</label><AnalyticsHelp label="排除已识别管理员" content={analyticsHelp.admin}/></div><div className="analytics-admin-filter-group"><label className="analytics-admin-filter"><input type="checkbox" checked={excludeInternal} onChange={event=>setExcludeInternal(event.target.checked)}/>排除已识别内网访问</label><AnalyticsHelp label="排除已识别内网访问" content={analyticsHelp.internal}/></div><span className="analytics-date-range">{data&&summary.updatedAt?`${beijingDay(data.since)} — ${beijingDay(summary.updatedAt)}`:'按所选日期查询'}</span></div>
      {Boolean(summary.error)&&<LoadError error={summary.error} retry={retry} stale={Boolean(data)}/>}
      <div role="status" className="analytics-update-status">{summary.stale?(summary.loading?'筛选更新中，暂显示上次统计结果…':'筛选更新未完成，暂显示上次统计结果'):''}</div>
      {!data&&summary.loading&&<SummarySkeleton/>}
      {data&&<div className="analytics-summary" aria-busy={summary.loading}>
        <div className="analytics-metrics"><MetricCard kind="views" help={analyticsHelp.views} label="页面访问" value={data.totals.pv} detail="Relay 页面浏览次数 · PV"/><MetricCard kind="visitors" help={analyticsHelp.visitors} label="估算访客" value={data.totals.uv} detail="按浏览器标识去重 · UV"/><MetricCard kind="users" label="访问账号" value={data.totals.users} detail="发生页面访问的已登录账号"/><MetricCard kind="actions" label="工具操作" value={data.totals.actions} detail="明确操作次数，包含各类结果"/></div>
        <div className="analytics-overview-grid"><DailyVisitsChart key={scope} daily={data.daily} since={data.since} earliest={data.earliest} now={summary.updatedAt??Date.now()}/><Ranking key={`pages-${scope}`} title="页面排行" description="按页面访问次数排序" rows={data.pages}/></div>
        <div className="analytics-section-label"><h2>功能使用</h2><span>从打开到操作，观察实际使用情况</span></div>
        <div className="analytics-usage-grid"><ToolsRanking key={`tools-${scope}`} rows={data.tools}/><Distribution title="工具操作结果" description="输入无效与系统处理错误分别统计" rows={data.results}/></div>
        <div className="analytics-context-grid"><Ranking key={`sources-${scope}`} title="页面来源" help={analyticsHelp.source} description="按页面访问次数统计；无来源信息不代表确定直接访问" rows={data.sources.map(row=>({...row,label:analyticsSourceName(row.label)}))} raw/><Distribution title="访问设备" description="按页面访问次数统计" rows={data.devices}/><Distribution title="登录结果" description={`${number(data.totals.logins)} 次登录判断，同一意图去重`} rows={data.loginResults}/></div>
        <div className="analytics-extra-grid"><section className="analytics-news"><span className="analytics-eyebrow">内容触达</span><h2>资讯点击</h2><strong>{number(data.totals.news)}<small>次</small></strong><p>外部阅读链接被点击的次数，<br/>不代表文章已加载或阅读完成。</p></section><Ranking key={`hosting-${scope}`} title="托管页面" help={analyticsHelp.hosting} description={`${number(data.totals.hosting)} 次 HTML 请求 · 与浏览器 PV 分开统计`} rows={data.hosting} raw/></div>
      </div>}
      <RecentVisits rows={visits.data} range={shownVisitRange} loading={visits.loading} error={visits.error} retry={retry} stale={visits.stale}/>
      <footer className="analytics-footer"><span>数据保存在本机 · 统计记录及全部字段长期保留</span><span>访客数为估算，不代表真实人数。{data?.earliest?`最早保留记录：${beijingDay(data.earliest)}。更早日期不代表零访问。`:''}</span></footer>
    </div></main>
  </div>;
}
