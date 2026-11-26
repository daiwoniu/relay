import {useEffect,useRef,useState,type FormEvent} from 'react';
import {featureAction} from '../../analytics/features';
import type {AnalyticsSummary,AnalyticsVisit} from '../../analytics/tracker';
import {useAuth} from '../../auth/AuthContext';
import RelayLogo from '../brand/RelayLogo';
import Popover from '../ui/Popover';
import DailyVisitsChart from './DailyVisitsChart';
import {Distribution,MetricCard,Ranking,RecentVisits,ToolsRanking,trackAnalyticsExpansion} from './AnalyticsSections';
import {analyticsRangeLabels,analyticsSourceName,beijingDateTimeInput,beijingDay,beijingTime,describeAnalyticsRange,number,parseBeijingDateTime,type AnalyticsRange} from './analytics-presentation';
import {useAnalyticsResource} from './useAnalyticsResource';
import AnalyticsHelp,{analyticsHelp} from './AnalyticsHelp';
import AnalyticsResourceState from './AnalyticsResourceState';
import FeatureAnalytics from './FeatureAnalytics';
import AnalyticsBackToTop from './AnalyticsBackToTop';
import {featureLabel,featureTotals,type FeatureData} from './feature-presentation';
import './analytics.css';

type Quality={server:{startedAt:number;queueDropped:number;writeFailed:number;observationsDropped:number;validationRejected:number;rateLimited:number}};
const presetRanges=['24h','7d','30d'] as const;
type TimePreset=typeof presetRanges[number]|'today';
type TimeSelection={range:TimePreset}|{range:'custom';startAt:number;endAt:number};
export default function AnalyticsPage(){
  const {user}=useAuth();
  const viewportRef=useRef<HTMLElement>(null);
  const [time,setTime]=useState<TimeSelection>({range:'7d'}),[excludeAdmin,setExcludeAdmin]=useState(false),[excludeInternal,setExcludeInternal]=useState(false),[refresh,setRefresh]=useState(0),[cooling,setCooling]=useState(false);
  const [rangeMenuAnchor,setRangeMenuAnchor]=useState<DOMRect|null>(null);
  const [customOpen,setCustomOpen]=useState(false);
  const rangeMenuRef=useRef<HTMLButtonElement>(null);
  const customStartRef=useRef<HTMLInputElement>(null);
  const [draft,setDraft]=useState(()=>{
    const now=Date.now();
    return{start:beijingDateTimeInput(now-86_400_000),end:beijingDateTimeInput(now)};
  });
  const [rangeError,setRangeError]=useState('');
  const [focus,setFocus]=useState<{id:number;feature?:string}>();
  const {range}=time;
  const allowed=user?.role==='admin',account=user?.id??'';
  const query=`range=${range}&excludeAdmin=${excludeAdmin}&excludeInternal=${excludeInternal}${time.range==='custom'?`&startAt=${time.startAt}&endAt=${time.endAt}`:''}`;
  const summary=useAnalyticsResource<AnalyticsSummary>(allowed?`/api/admin/analytics/summary?${query}`:null,account,refresh);
  const visits=useAnalyticsResource<AnalyticsVisit[]>(allowed?`/api/admin/analytics/visits?${query}`:null,account,refresh);
  const features=useAnalyticsResource<FeatureData>(allowed?`/api/admin/analytics/features?${query}`:null,account,refresh);
  const quality=useAnalyticsResource<Quality>(allowed?'/api/admin/analytics/quality':null,account,refresh);
  const resources=[['访问汇总',summary],['功能统计',features],['访问记录',visits],['采集状态',quality]] as const;
  const loading=resources.some(([,resource])=>resource.loading),failed=resources.filter(([,resource])=>resource.error).length;
  const data=summary.data,totals=featureTotals(features.data),{topFailure}=totals,q=quality.data?.server;
  const submits=features.data?.messageSubmits??features.data?.operations.find(row=>row.registrationId==='composer.submit')?.count??null;
  const qualityAbnormal=q?[q.queueDropped,q.writeFailed,q.observationsDropped,q.validationRejected,q.rateLimited].some(value=>value>0):false;
  useEffect(()=>{const previous=document.title;document.title='访问统计 · Relay';return()=>{document.title=previous;};},[]);
  useEffect(()=>{if(!cooling)return;const timer=setTimeout(()=>setCooling(false),5000);return()=>clearTimeout(timer);},[cooling]);
  useEffect(()=>{if(customOpen)customStartRef.current?.focus();},[customOpen]);
  const reload=()=>{featureAction('analytics',failed?'retry':'refresh','admin');setRefresh(value=>value+1);setCooling(true);};
  const selectPreset=(next:TimePreset)=>{
    if(range!==next){featureAction('analytics','range','admin');setTime({range:next});}
    setRangeMenuAnchor(null);
    setCustomOpen(false);
  };
  const closeCustom=()=>{
    setCustomOpen(false);
    rangeMenuRef.current?.focus();
  };
  const applyCustom=(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();
    const startAt=parseBeijingDateTime(draft.start),endAt=parseBeijingDateTime(draft.end);
    if(!Number.isFinite(startAt)||!Number.isFinite(endAt)||startAt<0||startAt>=endAt||endAt>Date.now()){
      setRangeError('请选择有效的起止时间，开始须早于结束，结束不得晚于当前时间。');
      return;
    }
    if(time.range!=='custom'||time.startAt!==startAt||time.endAt!==endAt){
      featureAction('analytics','range','admin');
      setTime({range:'custom',startAt,endAt});
    }
    setRangeError('');
    closeCustom();
  };
  const showFailures=(feature?:string)=>{
    featureAction('analytics','details','admin');
    setFocus(previous=>({id:(previous?.id??0)+1,feature}));
  };
  if(!allowed)return <p className="p-6">仅管理员可查看统计。</p>;
  const shownVisitRange=(visits.dataPath?new URLSearchParams(visits.dataPath.split('?')[1]).get('range'):range) as AnalyticsRange;
  const shownSummaryRange=(summary.dataPath?new URLSearchParams(summary.dataPath.split('?')[1]).get('range'):range) as AnalyticsRange;
  return <div className="analytics-page">
    <header className="analytics-brandbar"><div><RelayLogo className="h-7 w-7 shrink-0 text-[var(--color-brand-mark)]"/><strong>Relay</strong><span className="analytics-brand-divider"/><span>访问统计</span><span className="analytics-admin-label">管理员</span></div></header>
    <main ref={viewportRef} className="analytics-scroll"><div className="analytics-content">
      <div className="analytics-hero">
        <h1>访问与功能使用</h1>
        <div className="analytics-refresh">
          <span role="status">{loading?'正在更新各模块…':failed?`${failed} 个模块更新失败`:summary.updatedAt?`更新于 ${beijingTime(summary.updatedAt)}`:''}</span>
          <button type="button" className="analytics-button" onClick={reload} disabled={loading||cooling}>{loading?'读取中…':cooling?'稍后可刷新':'刷新数据'}</button>
        </div>
      </div>
      <div className="analytics-toolbar" id="analytics-filters">
        <div className="analytics-time-controls">
          <div className="analytics-segment" role="group" aria-label="统计时间">
            {presetRanges.map(value=><button key={value} type="button" aria-pressed={range===value} onClick={()=>selectPreset(value)}>{analyticsRangeLabels[value]}</button>)}
            <button ref={rangeMenuRef} type="button" aria-pressed={range==='custom'||range==='today'} aria-haspopup="dialog" aria-expanded={Boolean(rangeMenuAnchor)}
              onMouseDown={event=>{if(rangeMenuAnchor)event.stopPropagation();}}
              onClick={event=>{trackAnalyticsExpansion();setRangeMenuAnchor(rangeMenuAnchor?null:event.currentTarget.getBoundingClientRect());}}>
              {range==='today'?'今天':'自定义'} <span aria-hidden="true">▾</span>
            </button>
            {rangeMenuAnchor&&<Popover open anchorRect={rangeMenuAnchor} label="其他时间范围" placement="bottom" manageFocus onClose={()=>setRangeMenuAnchor(null)} className="analytics-range-menu">
              <button type="button" aria-pressed={range==='today'} onClick={()=>selectPreset('today')}>今天</button>
              <button type="button" aria-controls="analytics-custom-time" aria-expanded={customOpen} onClick={()=>{trackAnalyticsExpansion();setRangeMenuAnchor(null);setRangeError('');setCustomOpen(true);}}>选择起止时间</button>
            </Popover>}
          </div>
          <span className="analytics-date-range">{data&&summary.updatedAt?`${summary.stale?'上次筛选：':''}${describeAnalyticsRange(shownSummaryRange,data.since,data.until??summary.updatedAt,summary.updatedAt)} · 北京时间`:'按所选时间查询'}</span>
        </div>
        <div className="analytics-admin-filter-group"><label className="analytics-admin-filter"><input type="checkbox" checked={excludeAdmin} onChange={event=>{featureAction('analytics','filter','admin');setExcludeAdmin(event.target.checked);}}/>排除已识别管理员</label><AnalyticsHelp label="排除已识别管理员" content={analyticsHelp.admin}/></div>
        <div className="analytics-admin-filter-group"><label className="analytics-admin-filter"><input type="checkbox" checked={excludeInternal} onChange={event=>{featureAction('analytics','filter','admin');setExcludeInternal(event.target.checked);}}/>排除已识别内网访问</label><AnalyticsHelp label="排除已识别内网访问" content={analyticsHelp.internal}/></div>
        <form id="analytics-custom-time" className="analytics-custom-time" aria-label="自定义时间（北京时间）" hidden={!customOpen} onSubmit={applyCustom}>
          <label>开始时间（北京时间）<input ref={customStartRef} type="datetime-local" required value={draft.start} onChange={event=>{setDraft({...draft,start:event.target.value});setRangeError('');}}/></label>
          <label>结束时间（北京时间）<input type="datetime-local" required value={draft.end} onChange={event=>{setDraft({...draft,end:event.target.value});setRangeError('');}}/></label>
          <button type="submit" className="analytics-button">应用时间范围</button>
          <button type="button" className="analytics-button" onClick={()=>{trackAnalyticsExpansion();closeCustom();}}>取消</button>
          {rangeError&&<p role="alert">{rangeError}</p>}
        </form>
      </div>
      <div className={data||features.data?'analytics-overview-grid':undefined}>
        <div className="analytics-overview-main">
          <div className="analytics-metrics">
            <MetricCard kind="views" help={analyticsHelp.views} label="页面访问" value={data?.totals.pv??null} stale={summary.stale} detail="Relay 页面浏览次数 · PV"/>
            <MetricCard kind="visitors" help={analyticsHelp.visitors} label="估算访客" value={data?.totals.uv??null} stale={summary.stale} detail={data?`${number(data.totals.users)} 个访问账号`:'按浏览器标识去重 · UV'}/>
            <MetricCard kind="actions" label="消息提交" value={submits} stale={features.stale} detail="发送消息的明确操作次数"/>
            <MetricCard kind="hosting" label="托管请求" value={data?.totals.hosting??null} stale={summary.stale} detail="托管 HTML 文档请求次数"/>
          </div>
          {(Boolean(summary.error)||!data)&&<AnalyticsResourceState resource={summary} label="访问汇总"/>}
          {data&&<DailyVisitsChart key={account} daily={data.daily} trend={data.trend} since={data.since} until={data.until} earliest={data.earliest} now={summary.updatedAt??Date.now()}/>}
        </div>
        {(data||features.data)&&<div className="analytics-overview-side">
          {data&&<Ranking key={`pages-${account}`} title="页面排行" description="按页面访问次数排序" rows={data.pages} shareTotal={data.totals.pv}/>}
          <section className="analytics-incident" aria-label="处理失败记录">
            <div className="analytics-incident-heading">处理失败<AnalyticsHelp label="处理失败" content={analyticsHelp.failures}/>
              <button type="button" className="analytics-text-button" disabled={!totals.errors||features.stale} onClick={()=>showFailures()} aria-label="查看全部处理失败记录">{features.data?`${number(totals.errors)} 条`:'—'}</button>
            </div>
            {features.stale?<p>暂显示上次筛选结果</p>:topFailure&&<button type="button" className="analytics-text-button" onClick={()=>showFailures(topFailure.feature)}>{featureLabel(topFailure.feature)} · {number(topFailure.count)} 条失败 <span aria-hidden="true">→</span></button>}
          </section>
        </div>}
      </div>
      <FeatureAnalytics key={account} query={query} account={account} refresh={refresh} features={features} focus={focus}/>
      {data&&<details className="analytics-panel analytics-secondary" open>
        <summary onClick={trackAnalyticsExpansion}>访问来源与使用环境<span>来源、设备、登录及工具使用补充信息</span></summary>
        <div className="analytics-summary">
          <p className="analytics-footnote">明确操作 {features.data?number(totals.actions):'—'}{features.stale?'（上次筛选）':''} · 资讯外链点击 {number(data.totals.news)}（不代表阅读完成）</p>
          <div className="analytics-context-grid">
            <Ranking title="页面来源" help={analyticsHelp.source} rows={data.sources.map(row=>({...row,label:analyticsSourceName(row.label)}))} raw shareTotal={data.totals.pv}/>
            <Distribution title="访问设备" description="按页面 PV 统计" rows={data.devices}/>
            <Distribution title="登录结果" description="同一登录意图去重" rows={data.loginResults}/>
          </div>
          <div className="analytics-usage-grid">
            <ToolsRanking key={account} rows={data.tools}/>
            <Distribution title="工具操作结果（含自动完成）" rows={data.results}/>
          </div>
          <Ranking title="托管 HTML 请求" help={analyticsHelp.hosting} description={`${number(data.totals.hosting)} 次请求，与页面 PV 分开`} rows={data.hosting} raw shareTotal={data.totals.hosting}/>
        </div>
      </details>}
      <RecentVisits rows={visits.data} range={shownVisitRange} loading={visits.loading} error={visits.error} retry={visits.retry} stale={visits.stale}/>
      <details className="analytics-panel analytics-quality"><summary onClick={trackAnalyticsExpansion}>统计采集状态<span>{quality.loading?'读取中':quality.error?'状态读取失败':qualityAbnormal?'检测到采集异常，展开查看':q?'本次后端启动以来未报告采集异常':'尚未读取采集状态'}</span></summary><p className="analytics-footnote">本次启动以来的采集健康检查<AnalyticsHelp label="统计采集状态" content={analyticsHelp.quality}/></p><AnalyticsResourceState resource={quality} label="采集状态"/>{q&&<><p>本次服务自 {beijingTime(q.startedAt)} 启动，以下计数不随日期筛选变化，重启后重新计数。</p><dl className="analytics-quality-grid">{[['校验拒绝批次',q.validationRejected],['限流批次',q.rateLimited],['队列丢弃事件',q.queueDropped],['写入失败事件',q.writeFailed],['结果采集未完成',q.observationsDropped]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{number(Number(value))}</dd></div>)}</dl></>}{features.data?.unrecognized?<p role="status">当前范围有 {number(features.data.unrecognized)} 条未识别事件，未纳入功能排行。</p>:null}</details>
      <details className="analytics-read-status">
        <summary onClick={trackAnalyticsExpansion}>各模块读取状态</summary>
        <div className="analytics-module-status" aria-label="各模块读取状态">{resources.map(([label,resource])=><span key={label} data-state={resource.error?'error':resource.loading?'loading':'ready'}><span className="analytics-module-label">{label}<small>{resource.error?'失败':resource.stale?'上次筛选':resource.loading?'读取中':'已更新'}</small></span><span className="analytics-module-time">{resource.updatedAt?`${beijingTime(resource.updatedAt)}${resource.cached?' · 缓存':''}`:'尚未读取'}</span></span>)}</div>
      </details>
      <footer className="analytics-footer"><span>数据保存在本机并长期保留。访客数为估算值。{data?.earliest?`最早保留记录：${beijingDay(data.earliest)}，更早日期不代表零访问。`:''}<AnalyticsHelp label="统计说明" content={analyticsHelp.retention}/></span></footer>
    </div></main>
    <AnalyticsBackToTop viewportRef={viewportRef}/>
  </div>;
}
