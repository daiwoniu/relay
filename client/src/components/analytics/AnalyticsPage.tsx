import {useEffect,useRef,useState} from 'react';
import {featureAction} from '../../analytics/features';
import type {AnalyticsSummary,AnalyticsVisit} from '../../analytics/tracker';
import {useAuth} from '../../auth/AuthContext';
import RelayLogo from '../brand/RelayLogo';
import DailyVisitsChart from './DailyVisitsChart';
import {Distribution,MetricCard,Ranking,RecentVisits,ToolsRanking} from './AnalyticsSections';
import {analyticsSourceName,beijingDay,beijingTime,number} from './analytics-presentation';
import {useAnalyticsResource} from './useAnalyticsResource';
import AnalyticsHelp,{analyticsHelp} from './AnalyticsHelp';
import AnalyticsResourceState from './AnalyticsResourceState';
import FeatureAnalytics from './FeatureAnalytics';
import AnalyticsBackToTop from './AnalyticsBackToTop';
import {featureTotals,type FeatureData} from './feature-presentation';
import './analytics.css';

type Quality={server:{startedAt:number;queueDropped:number;writeFailed:number;observationsDropped:number;validationRejected:number;rateLimited:number}};
export default function AnalyticsPage(){
  const {user}=useAuth();
  const viewportRef=useRef<HTMLElement>(null);
  const [range,setRange]=useState<'today'|'7d'|'30d'|'all'>('7d'),[excludeAdmin,setExcludeAdmin]=useState(false),[excludeInternal,setExcludeInternal]=useState(false),[refresh,setRefresh]=useState(0),[cooling,setCooling]=useState(false),[focus,setFocus]=useState(0);
  const allowed=user?.role==='admin',account=user?.id??'',query=`range=${range}&excludeAdmin=${excludeAdmin}&excludeInternal=${excludeInternal}`;
  const summary=useAnalyticsResource<AnalyticsSummary>(allowed?`/api/admin/analytics/summary?${query}`:null,account,refresh);
  const visits=useAnalyticsResource<AnalyticsVisit[]>(allowed?`/api/admin/analytics/visits?${query}`:null,account,refresh);
  const features=useAnalyticsResource<FeatureData>(allowed?`/api/admin/analytics/features?${query}`:null,account,refresh);
  const quality=useAnalyticsResource<Quality>(allowed?'/api/admin/analytics/quality':null,account,refresh);
  const resources=[['访问汇总',summary],['功能统计',features],['访问记录',visits],['采集状态',quality]] as const;
  const loading=resources.some(([,resource])=>resource.loading),failed=resources.filter(([,resource])=>resource.error).length;
  const data=summary.data,totals=featureTotals(features.data),q=quality.data?.server;
  const qualityAbnormal=q?[q.queueDropped,q.writeFailed,q.observationsDropped,q.validationRejected,q.rateLimited].some(value=>value>0):false;
  useEffect(()=>{const previous=document.title;document.title='访问统计 · Relay';return()=>{document.title=previous;};},[]);
  useEffect(()=>{if(!cooling)return;const timer=setTimeout(()=>setCooling(false),5000);return()=>clearTimeout(timer);},[cooling]);
  const reload=()=>{featureAction('analytics',failed?'retry':'refresh','admin');setRefresh(value=>value+1);setCooling(true);};
  if(!allowed)return <p className="p-6">仅管理员可查看统计。</p>;
  const shownVisitRange=(visits.dataPath?new URLSearchParams(visits.dataPath.split('?')[1]).get('range'):range) as typeof range;
  return <div className="analytics-page">
    <header className="analytics-brandbar"><div><RelayLogo className="h-7 w-7 shrink-0 text-[var(--color-brand-mark)]"/><strong>Relay</strong><span className="analytics-brand-divider"/><span>访问统计</span><span className="analytics-admin-label">管理员</span></div></header>
    <main ref={viewportRef} className="analytics-scroll"><div className="analytics-content">
      <div className="analytics-hero"><div><h1>访问与功能使用</h1></div><div className="analytics-refresh"><span role="status" data-active={loading||failed>0}>{loading?'正在更新各模块…':failed?`${failed} 个模块更新失败`:'各模块读取完成'}</span><button type="button" className="analytics-button" onClick={reload} disabled={loading||cooling}>{loading?'读取中…':cooling?'稍后可刷新':'刷新数据'}</button></div></div>
      <div className="analytics-toolbar" id="analytics-filters"><div className="analytics-segment" role="group" aria-label="统计日期">{(['today','7d','30d','all'] as const).map(value=><button key={value} type="button" aria-pressed={range===value} onClick={()=>{if(range!==value)featureAction('analytics','range','admin');setRange(value);}}>{value==='today'?'今天':value==='7d'?'近 7 天':value==='30d'?'近 30 天':'所有时间'}</button>)}</div><div className="analytics-admin-filter-group"><label className="analytics-admin-filter"><input type="checkbox" checked={excludeAdmin} onChange={event=>{featureAction('analytics','filter','admin');setExcludeAdmin(event.target.checked);}}/>排除已识别管理员</label><AnalyticsHelp label="排除已识别管理员" content={analyticsHelp.admin}/></div><div className="analytics-admin-filter-group"><label className="analytics-admin-filter"><input type="checkbox" checked={excludeInternal} onChange={event=>{featureAction('analytics','filter','admin');setExcludeInternal(event.target.checked);}}/>排除已识别内网访问</label><AnalyticsHelp label="排除已识别内网访问" content={analyticsHelp.internal}/></div><span className="analytics-date-range">{data&&summary.updatedAt?`${summary.stale?'上次筛选：':''}${beijingDay(data.since)} — ${beijingDay(summary.updatedAt)}`:'按所选日期查询'}</span></div>
      <div className="analytics-module-status" aria-label="各模块读取状态">{resources.map(([label,resource])=><span key={label} data-state={resource.error?'error':resource.loading?'loading':'ready'}><span className="analytics-module-label">{label}<small>{resource.error?'失败':resource.stale?'上次筛选':resource.loading?'读取中':'已更新'}</small></span><span className="analytics-module-time">{resource.updatedAt?`${beijingTime(resource.updatedAt)}${resource.cached?' · 缓存':''}`:'尚未读取'}</span></span>)}</div>
      <div className="analytics-metrics"><MetricCard kind="views" help={analyticsHelp.views} label="页面访问" value={data?.totals.pv??null} stale={summary.stale} detail="Relay 页面浏览次数 · PV"/><MetricCard kind="visitors" help={analyticsHelp.visitors} label="估算访客" value={data?.totals.uv??null} stale={summary.stale} detail="按浏览器标识去重 · UV"/><MetricCard kind="actions" help={analyticsHelp.actions} label="明确操作" value={features.data?totals.actions:null} stale={features.stale} detail="不含系统观察与自动完成"/><MetricCard kind="failures" help={analyticsHelp.failures} label="处理失败记录" value={features.data?totals.errors:null} stale={features.stale} detail="点击定位 · 不含取消、拒绝与系统事件" onClick={()=>{featureAction('analytics','details','admin');setFocus(value=>value+1);}}/></div>
      {(Boolean(summary.error)||!data)&&<AnalyticsResourceState resource={summary} label="访问汇总"/>}
      {data&&<div className="analytics-overview-grid"><DailyVisitsChart key={account} daily={data.daily} since={data.since} earliest={data.earliest} now={summary.updatedAt??Date.now()}/><Ranking key={`pages-${account}`} title="页面排行" description="按页面访问次数排序" rows={data.pages}/></div>}
      <FeatureAnalytics key={account} query={query} account={account} refresh={refresh} features={features} focus={focus}/>
      <details className="analytics-panel analytics-secondary"><summary>访问来源与使用环境<span>来源、设备、登录及工具使用补充信息</span></summary>{data?<div className="analytics-summary"><p className="analytics-footnote">访问账号 {number(data.totals.users)} · 工具操作（含自动完成） {number(data.totals.actions)} · 资讯外链点击 {number(data.totals.news)}（不代表阅读完成）</p><div className="analytics-context-grid"><Ranking title="页面来源" help={analyticsHelp.source} rows={data.sources.map(row=>({...row,label:analyticsSourceName(row.label)}))} raw/><Distribution title="访问设备" description="按页面 PV 统计" rows={data.devices}/><Distribution title="登录结果" description="同一登录意图去重" rows={data.loginResults}/></div><div className="analytics-usage-grid"><ToolsRanking key={account} rows={data.tools}/><Distribution title="工具操作结果（含自动完成）" rows={data.results}/></div><Ranking title="托管 HTML 请求" help={analyticsHelp.hosting} description={`${number(data.totals.hosting)} 次请求，与页面 PV 分开`} rows={data.hosting} raw/></div>:<AnalyticsResourceState resource={summary} label="辅助统计"/>}</details>
      <RecentVisits rows={visits.data} range={shownVisitRange} loading={visits.loading} error={visits.error} retry={visits.retry} stale={visits.stale}/>
      <details className="analytics-panel analytics-quality"><summary>统计采集状态<span>{quality.loading?'读取中':quality.error?'状态读取失败':qualityAbnormal?'检测到采集异常，展开查看':q?'本次后端启动以来未报告采集异常':'尚未读取采集状态'}</span></summary><p className="analytics-footnote">本次启动以来的采集健康检查<AnalyticsHelp label="统计采集状态" content={analyticsHelp.quality}/></p><AnalyticsResourceState resource={quality} label="采集状态"/>{q&&<><p>本次服务自 {beijingTime(q.startedAt)} 启动，以下计数不随日期筛选变化，重启后重新计数。</p><dl className="analytics-quality-grid">{[['校验拒绝批次',q.validationRejected],['限流批次',q.rateLimited],['队列丢弃事件',q.queueDropped],['写入失败事件',q.writeFailed],['结果采集未完成',q.observationsDropped]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{number(Number(value))}</dd></div>)}</dl></>}{features.data?.unrecognized?<p role="status">当前范围有 {number(features.data.unrecognized)} 条未识别事件，未纳入功能排行。</p>:null}</details>
      <footer className="analytics-footer"><span>数据保存在本机并长期保留；访客数为估算值。{data?.earliest?`最早保留记录：${beijingDay(data.earliest)}，更早日期不代表零访问。`:''}<AnalyticsHelp label="统计说明" content={analyticsHelp.retention}/></span></footer>
    </div></main>
    <AnalyticsBackToTop viewportRef={viewportRef}/>
  </div>;
}
