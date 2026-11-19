import { useState,type ReactNode } from 'react';
import type { AnalyticsSummary,AnalyticsVisit } from '../../analytics/tracker';
import FailureNotice from '../ui/FailureNotice';
import AnalyticsHelp,{analyticsHelp} from './AnalyticsHelp';
import { analyticsName as name,analyticsBrowserName,analyticsOsName,analyticsVisitSource,beijingTime,number,resultTone,sortedTools } from './analytics-presentation';

export function SectionHeading({title,description,children,help}:{title:string;description?:string;children?:ReactNode;help?:string}){
  return <div className="analytics-section-heading"><div><h2>{title}{help&&<AnalyticsHelp label={title} content={help}/>}</h2>{description&&<p>{description}</p>}</div>{children}</div>;
}
export function EmptyState({children='当前筛选下暂无记录'}:{children?:ReactNode}){
  return <div className="analytics-empty"><span aria-hidden="true">—</span><p>{children}</p></div>;
}
export function LoadError({error,retry,stale=false}:{error:unknown;retry:()=>void;stale?:boolean}){
  return <div className="analytics-error" role="alert">{stale&&<p>更新未完成，以下保留上次成功读取的数据。</p>}<FailureNotice error={error}/><button type="button" className="analytics-button" onClick={retry}>重新读取</button></div>;
}
export function SummarySkeleton(){
  return <div className="analytics-skeleton" role="status" aria-label="正在读取统计"><div className="analytics-metrics">{[0,1,2,3].map(i=><div key={i}/>)}</div><div className="analytics-skeleton-chart"/><span className="sr-only">正在读取统计</span></div>;
}
export function MetricCard({label,value,detail,kind,help,onClick,stale=false}:{label:string;value:number|null;detail:string;kind:'views'|'visitors'|'users'|'actions'|'failures';help?:string;onClick?:()=>void;stale?:boolean}){
  const paths={views:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0',visitors:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8m6 10v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',users:'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',actions:'m13 2-9 12h7l-1 8 10-12h-7l1-8Z',failures:'m12 3 10 18H2L12 3Zm0 6v5m0 3h.01'};
  const display=value===null?'—':number(value);
  return <section className={`analytics-metric analytics-metric--${kind}`} data-alert={kind==='failures'&&value!==null&&value>0}><div className="analytics-metric-label"><span className="analytics-heading-text">{label}{help&&<AnalyticsHelp label={label} content={help}/>}</span><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]}/></svg></div><strong>{onClick?<button type="button" className="analytics-metric-link" onClick={onClick} aria-label={`查看${label}明细`}>{display}</button>:display}</strong><p><span className={stale?'analytics-copy-hidden':undefined} aria-hidden={stale}>{detail}</span><span className={stale?undefined:'analytics-copy-hidden'} aria-hidden={!stale}>暂显示上次筛选结果</span></p></section>;
}
import {featureAction} from '../../analytics/features';
export function Ranking({title,rows,raw=false,description,help}:{title:string;rows:Array<{label:string;count:number}>;raw?:boolean;description?:string;help?:string}){
  const [expanded,setExpanded]=useState(false),max=Math.max(1,...rows.map(r=>r.count));
  return <section className="analytics-panel"><SectionHeading title={title} description={description} help={help}/>{!rows.length?<EmptyState/>:<ol className="analytics-ranking">{rows.slice(0,expanded?undefined:5).map((row,i)=><li key={`${row.label}-${i}`}><span className="analytics-rank-index">{String(i+1).padStart(2,'0')}</span><div><div className="analytics-rank-label"><span>{raw?row.label:name(row.label)}</span><strong>{number(row.count)}</strong></div><div className="analytics-track" aria-hidden="true"><span style={{width:`${row.count/max*100}%`}}/></div></div></li>)}</ol>}{rows.length>5&&<button className="analytics-text-button" type="button" aria-expanded={expanded} onClick={()=>{featureAction('analytics','expand','admin');setExpanded(v=>!v);}}>{expanded?'收起':`查看其余 ${rows.length-5} 项`}</button>}</section>;
}
export function Distribution({title,rows,description}:{title:string;rows:Array<{label:string;count:number}>;description?:string}){
  const total=rows.reduce((sum,row)=>sum+row.count,0);
  return <section className="analytics-panel"><SectionHeading title={title} description={description}/>{!total?<EmptyState/>:<ul className="analytics-distribution-list">{rows.map(r=><li key={r.label}><span className="analytics-dot" data-tone={resultTone(r.label)} data-category={r.label}/><span>{name(r.label)}</span><strong>{number(r.count)}</strong><small>{(r.count/total*100).toFixed(1)}%</small><div className="analytics-distribution-row-track" aria-hidden="true"><span data-tone={resultTone(r.label)} data-category={r.label} style={{width:`${r.count/total*100}%`}}/></div></li>)}</ul>}</section>;
}
export function ToolsRanking({rows}:{rows:AnalyticsSummary['tools']}){
  const [sort,setSort]=useState<'opens'|'actions'>('actions'),[expanded,setExpanded]=useState(false);
  const sorted=sortedTools(rows,sort),max=Math.max(1,...sorted.map(row=>row[sort]));
  return <section className="analytics-panel"><SectionHeading title="工具使用" description="工具运行记录，含自动完成" help={analyticsHelp.tools}><div className="analytics-segment" role="group" aria-label="工具排序">{(['actions','opens'] as const).map(key=><button key={key} type="button" aria-pressed={sort===key} onClick={()=>{if(sort!==key)featureAction('analytics','metric','admin');setSort(key);}}>{key==='actions'?'按操作':'按打开'}</button>)}</div></SectionHeading>{!rows.length?<EmptyState/>:<div className="analytics-tools"><div className="analytics-tools-head"><span>工具</span><span>打开</span><span>操作</span></div>{sorted.slice(0,expanded?undefined:5).map((r,i)=><div className="analytics-tool-row" key={r.label}><div><div className="analytics-tool-name"><span className="analytics-rank-index">{i+1}</span><span>{name(r.label)}</span></div><div className="analytics-track" aria-hidden="true"><span style={{width:`${r[sort]/max*100}%`}}/></div></div><span data-active={sort==='opens'}>{number(r.opens)}</span><span data-active={sort==='actions'}>{number(r.actions)}</span></div>)}</div>}{rows.length>5&&<button className="analytics-text-button" type="button" aria-expanded={expanded} onClick={()=>{featureAction('analytics','expand','admin');setExpanded(v=>!v);}}>{expanded?'收起':`查看全部 ${rows.length} 个工具`}</button>}</section>;
}
function ResultBadge({value,eventName}:{value:string|null;eventName:string}){return value?<span className="analytics-badge" data-tone={resultTone(value)}>{name(value)}</span>:eventName==='login_result'?<span className="analytics-muted">未记录</span>:null;}
function ClientType({value}:{value:AnalyticsVisit['clientSource']}){
  return value?<span className="analytics-client-type">{value==='gateway'?'前端网关':value==='pwa'?'PWA':'Web'}</span>:null;
}
function VisitEnvironment({row}:{row:AnalyticsVisit}){
  const missing=row.device==='unknown'&&row.browser==='Other'&&row.os==='Other'&&!row.clientSource&&!row.clientVersion;
  if(missing)return <span className="analytics-muted">访问环境未记录</span>;
  return <div className="analytics-visit-environment">
    <strong>{name(row.device)} · {analyticsOsName(row.os)}</strong>
    <div className="analytics-environment-meta"><span>{analyticsBrowserName(row.browser)}</span><ClientType value={row.clientSource}/>{row.clientVersion&&<span className="analytics-client-version" aria-label={`前端版本 ${row.clientVersion}`}>v{row.clientVersion}</span>}</div>
  </div>;
}
function VisitDetails({row}:{row:AnalyticsVisit}){
  return <details className="analytics-visit-details"><summary>详情<span className="sr-only">：{name(row.page)}，{beijingTime(row.at)}</span></summary><dl>
    <div><dt>页面来源</dt><dd>{analyticsVisitSource(row)}</dd></div>
    <div><dt>访问主机</dt><dd>{row.accessHost??'未记录'}</dd></div>
    <div><dt>来源网络</dt><dd>{row.networkType==='internal'?'本机 / 内网':row.networkType==='public'?'公网':'未识别'}</dd></div>
    <div><dt>访问方式</dt><dd>{row.accessType==='ip'?'IP访问':row.accessType==='domain'?'域名访问':'未记录'}</dd></div>
    <div><dt>前端类型</dt><dd>{row.clientSource==='gateway'?'前端网关':row.clientSource==='pwa'?'PWA':row.clientSource==='web'?'Web':'未记录'}</dd></div>
    <div><dt className="analytics-heading-text">前端版本<AnalyticsHelp label="前端版本" content={analyticsHelp.version}/></dt><dd>{row.clientVersion??'未记录'}</dd></div>
    <div><dt>服务端版本</dt><dd>{row.serverVersion??'未记录'}</dd></div>
    {row.backfilled&&<div className="analytics-backfill"><dt><span className="analytics-chip">已补录</span></dt><dd>部分信息按确认规则补齐，并非原始采集值。</dd></div>}
  </dl></details>;
}
export function RecentVisits({rows,range,loading,error,retry,stale=false}:{rows:AnalyticsVisit[]|null;range:'today'|'7d'|'30d'|'all';loading:boolean;error:unknown;retry:()=>void;stale?:boolean}){
  return <details className="analytics-panel analytics-recent" aria-busy={loading} onToggle={()=>featureAction('analytics','expand','admin')}>
    <summary>最近访问<span>{range==='today'?'今天':range==='7d'?'近 7 天':range==='30d'?'近 30 天':'所有时间'} · 最多 50 条 · {loading?'读取中':error?'读取失败':stale?'暂显示上次筛选':rows?`已加载 ${rows.length} 条`:'尚未读取'}</span></summary>
    <p className="analytics-footnote">页面访问、登录结果及托管请求<AnalyticsHelp label="最近访问" content={analyticsHelp.recent}/></p>
    {Boolean(error)&&<LoadError error={error} retry={retry} stale={rows!==null}/>}
    <div role="status" className="analytics-update-status">{stale?(loading?'筛选更新中，暂显示上次访问记录…':'筛选更新未完成，暂显示上次访问记录'):loading?(rows?'正在更新访问记录…':'正在读取访问记录…'):rows?`已加载 ${rows.length} 条记录`:''}</div>
    {rows?.length?<><div className="analytics-visits-table"><table><colgroup><col style={{width:'16%'}}/><col style={{width:'13%'}}/><col style={{width:'7%'}}/><col style={{width:'17%'}}/><col style={{width:'21%'}}/><col style={{width:'26%'}}/></colgroup><thead><tr>{['时间','访问内容','身份','来源 IP','访问环境','结果 / 详情'].map(label=><th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>{rows.map(row=><tr key={row.id}>
        <td className="analytics-time"><time dateTime={new Date(row.at).toISOString()}>{beijingTime(row.at)}</time></td>
        <td><strong>{name(row.page)}</strong><small>{name(row.name)}</small></td>
        <td>{name(row.role)}</td><td className="analytics-ip">{row.ip??'未记录'}</td>
        <td className="analytics-environment-cell"><VisitEnvironment row={row}/></td>
        <td className="analytics-result-cell"><ResultBadge value={row.result} eventName={row.name}/><VisitDetails row={row}/></td>
      </tr>)}</tbody></table></div>
      <ul className="analytics-visit-cards">{rows.map(row=><li key={row.id}>
        <div className="analytics-visit-card-heading"><strong>{name(row.page)}</strong>{(row.result||row.name==='login_result')&&<ResultBadge value={row.result} eventName={row.name}/>}</div>
        <p>{name(row.name)} · {name(row.role)}</p>
        <VisitEnvironment row={row}/>
        <div className="analytics-visit-meta"><time dateTime={new Date(row.at).toISOString()}>{beijingTime(row.at)}</time><span>{row.ip??'IP未记录'}</span></div>
        <VisitDetails row={row}/>
      </li>)}</ul></>:rows!==null?<EmptyState>{stale?'上次筛选暂无访问记录':'当前筛选下暂无访问记录'}</EmptyState>:null}

  </details>;
}
