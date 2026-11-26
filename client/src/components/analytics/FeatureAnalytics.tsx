import {useCallback,useEffect,useRef,useState} from 'react';
import {featureAction} from '../../analytics/features';
import {useAnalyticsResource} from './useAnalyticsResource';
import {beijingTime,number,resultTone} from './analytics-presentation';
import {EmptyState,SectionHeading,trackAnalyticsExpansion} from './AnalyticsSections';
import AnalyticsResourceState,{type ResourceState} from './AnalyticsResourceState';
import AnalyticsHelp,{analyticsHelp} from './AnalyticsHelp';
import {scrollAnalyticsIntoView} from './analytics-scroll';
import {actionFailureDescription,actionLabel,actionsForFeature,detailPageSizes,detailQuery,emptyDetailFilter,featureFailureCount,featureLabel,featureOptions,metricLabel,resultLabel,type DetailFilter,type DetailPageSize,type FeatureData} from './feature-presentation';

type ActionRow={id:string;at:number;registrationId:string;feature:string;action:string;metric:string;result:string|null;automatic:boolean;durationMs:number|null;operationId:string|null;operationRecordCount?:number|null;details?:Record<string,string>};
const detailLabels:Record<string,string>={surface:'触发入口',engine:'引擎',settingKey:'设置类别',mode:'操作模式',section:'页签',toolId:'工具',fileKind:'文件类型',sizeBucket:'大小区间'};
const values:Record<string,string>={unknown:'未记录',settings:'设置中心',preview_toolbar:'预览工具栏',message_file:'消息附件或文件链接',composer:'输入区',message:'消息区',sidebar:'侧栏',user_menu:'用户菜单',session_details:'会话详情',preview_content:'预览内容',workbench:'工作台',admin:'管理页',keyboard:'键盘',system:'系统',profile:'个人资料',avatar:'头像',default_project:'默认项目',default_engine:'默认引擎',default_model:'默认模型',theme:'主题',notification:'通知',preview_capacity:'预览设置',preview_image:'图片设置',concurrency:'并发',source:'源码',rendered:'阅读',git_diff:'变更对比',create_bot:'新增机器人',edit_bot:'编辑配置',enable_bot:'启用机器人',disable_bot:'停用机器人',feishu_settings:'机器人配置',feishu_users:'使用权限',feishu_messages:'消息',feishu_matters:'事项',feishu_stats:'使用统计',
  text:'文本',code:'代码',markdown:'Markdown',html:'HTML',image:'图片',pdf:'PDF',word:'Word',spreadsheet:'表格',archive:'压缩包',audio:'音频',video:'视频',other:'其他',empty:'空文件',under_1mb:'小于 1 MB','1_5mb':'1–5 MB','5_20mb':'5–20 MB',over_20mb:'大于 20 MB'};
function Result({value}:{value:string}){return <span className="analytics-badge" data-tone={resultTone(value)}>{resultLabel[value]??value}</span>;}
function RowResult({row}:{row:ActionRow}){return row.result?<Result value={row.result}/>:<span className="analytics-muted">{row.metric==='view'?'仅记录访问':row.metric==='action'?'仅记录操作':'未记录结果'}</span>;}
export default function FeatureAnalytics({query,account,refresh,features,focus}:{query:string;account:string;refresh:number;features:ResourceState&{data:FeatureData|null};focus?:{id:number;feature?:string}}){
  const [filter,setFilter]=useState<DetailFilter>(emptyDetailFilter),[detailsOpen,setDetailsOpen]=useState(false);
  const [pageSize,setPageSize]=useState<DetailPageSize>(10);
  const [allFeatures,setAllFeatures]=useState(false),[allOperations,setAllOperations]=useState(false);
  const featureRows=features.data?.features??[],operationRows=features.data?.operations??[];
  const visibleFeatures=allFeatures?featureRows:featureRows.slice(0,6),visibleOperations=allOperations?operationRows:operationRows.slice(0,5);
  const [page,setPage]=useState<{scope:string;cursors:Array<{at:number;id:string}>}>({scope:'',cursors:[]});
  const detailsRef=useRef<HTMLDetailsElement>(null),scope=JSON.stringify([query,refresh,pageSize]);
  const beforeRelated=useRef<DetailFilter|null>(null);
  if(page.scope!==scope)setPage({scope,cursors:[]});
  const cursors=page.scope===scope?page.cursors:[],cursor=cursors[cursors.length-1];
  const actions=useAnalyticsResource<{items:ActionRow[];next:{at:number;id:string}|null}>(detailsOpen?`/api/admin/analytics/actions?${detailQuery(query,filter,cursor,pageSize)}`:null,account,refresh);
  const applyFilter=useCallback((next:DetailFilter)=>{
    setFilter(next);
    setPage({scope,cursors:[]});
  },[scope]);
  const revealDetails=useCallback((changes:Partial<DetailFilter>)=>{
    applyFilter({...emptyDetailFilter,...changes});
    setDetailsOpen(true);
    requestAnimationFrame(()=>scrollAnalyticsIntoView(detailsRef.current));
  },[applyFilter]);
  const handledFocus=useRef<typeof focus>(undefined);
  useEffect(()=>{
    if(!focus||handledFocus.current===focus)return;
    handledFocus.current=focus;
    revealDetails({feature:focus.feature??'',result:'error'});
  },[focus,revealDetails]);
  const show=(changes:Partial<DetailFilter>)=>{
    featureAction('analytics','details','admin');
    revealDetails(changes);
  };
  const update=(changes:Partial<DetailFilter>)=>{
    featureAction('analytics','filter','admin');
    applyFilter({...filter,...changes,operationId:'',...(changes.metric==='view'?{result:''}:changes.result&&filter.metric==='view'?{metric:''}:{})});
    beforeRelated.current=null;
  };
  const restoreFilter=(next:DetailFilter)=>{
    featureAction('analytics','filter','admin');
    applyFilter(next);
    beforeRelated.current=null;
  };
  const changePage=(next:typeof cursors)=>{featureAction('analytics','paginate','admin');setPage({scope,cursors:next});};
  const resultButtons=(row:FeatureData['features'][number])=>{
    const buttons=Object.entries(row.results).map(([result,count])=><button type="button" key={result} className="analytics-result-link" onClick={()=>show({feature:row.feature,result,metric:'result'})}><Result value={result}/><strong>{number(count)}</strong></button>);
    const localFailures=Math.max(0,featureFailureCount(row)-(row.results.error??0));
    if(localFailures)buttons.push(<button type="button" key="local-error" className="analytics-result-link" onClick={()=>show({feature:row.feature,result:'error',metric:'action'})}><span className="analytics-badge" data-tone="danger">本地操作失败</span><strong>{number(localFailures)}</strong></button>);
    return buttons.length?buttons:<span className="analytics-muted">暂无结果</span>;
  };
  const rowDetails=(row:ActionRow)=>{
    const reason=actionFailureDescription(row.result,row.details?.reasonCode);
    const count=row.operationRecordCount??0;
    return <details className="analytics-row-details">
      <summary onClick={trackAnalyticsExpansion}>查看详情</summary>
      {reason&&<p className="analytics-failure-reason"><strong>{row.result==='error'?'失败原因':'原因'}</strong> {reason}</p>}
      <dl>{Object.entries(row.details??{}).filter(([key])=>key!=='reasonCode').map(([key,value])=><div key={key}><dt>{detailLabels[key]??key}</dt><dd>{values[value]??value}</dd></div>)}
        <div><dt>已知耗时</dt><dd>{row.durationMs==null?'未记录':`${number(row.durationMs)} ms`}</dd></div>
      </dl>
      {row.operationId&&filter.operationId!==row.operationId&&(count>1?
        <span className="analytics-related-control"><button type="button" className="analytics-text-button" disabled={actions.stale} onClick={()=>{beforeRelated.current=filter;show({includeSystem:true,operationId:row.operationId!});}}>查看关联记录（{number(count)} 条）</button><AnalyticsHelp label="查看关联记录" content={analyticsHelp.related}/></span>:
        count===1&&<p className="analytics-muted analytics-related-control">当前范围只有这条操作记录。</p>)}
    </details>;
  };
  return <section className="analytics-feature-section" aria-label="全平台功能统计">
    <div className="analytics-feature-grid">
      <section className="analytics-panel" aria-busy={features.loading}><SectionHeading title="全平台功能" help={analyticsHelp.features} description="点击数字查看明细"/>
        <AnalyticsResourceState resource={features} label="功能统计"/>
        {features.data?.features.length?<><div className="analytics-data-table analytics-feature-table"><table><thead><tr><th scope="col">功能</th><th scope="col">访问</th><th scope="col">操作</th><th scope="col">操作结果</th></tr></thead><tbody>{visibleFeatures.map(row=><tr key={row.feature}><th scope="row">{featureLabel(row.feature)}</th><td><button type="button" className="analytics-count-link" onClick={()=>show({feature:row.feature,metric:'view'})}>{number(row.views)}</button></td><td><button type="button" className="analytics-count-link" onClick={()=>show({feature:row.feature,metric:'action'})}>{number(row.actions)}</button></td><td><div className="analytics-result-links">{resultButtons(row)}</div></td></tr>)}</tbody></table></div>
          <ul className="analytics-feature-cards">{visibleFeatures.map(row=><li key={row.feature}><strong>{featureLabel(row.feature)}</strong><div className="analytics-feature-card-counts"><button type="button" onClick={()=>show({feature:row.feature,metric:'view'})}>访问 <b>{number(row.views)}</b></button><button type="button" onClick={()=>show({feature:row.feature,metric:'action'})}>操作 <b>{number(row.actions)}</b></button></div><div className="analytics-result-links">{resultButtons(row)}</div></li>)}</ul></>:!features.loading&&!features.error?<EmptyState>所选范围暂无功能记录；早期未采集不代表无人使用。</EmptyState>:null}
        {featureRows.length>6&&<button type="button" className="analytics-list-toggle" aria-expanded={allFeatures} onClick={()=>{trackAnalyticsExpansion();setAllFeatures(value=>!value);}}>{allFeatures?'收起功能列表':`显示全部 ${number(featureRows.length)} 项功能`}</button>}
      </section>
      <section className="analytics-panel" aria-busy={features.loading}><SectionHeading title="操作排行" description="按操作次数排序 · 最多20项"/>{features.loading&&!features.data?<p role="status">正在读取排行…</p>:null}
        {features.data?.operations.length?<ol className="analytics-operation-ranking">{visibleOperations.map((row,index)=><li key={`${row.feature}:${row.registrationId}`}><button type="button" onClick={()=>show({feature:row.feature,action:row.action,metric:'action'})}><span className="analytics-rank-index">{index+1}</span><span><strong>{featureLabel(row.feature)}</strong><small>{actionLabel(row.registrationId,row.action)}</small></span><b>{number(row.count)}</b></button></li>)}</ol>:!features.loading&&!features.error?<EmptyState>暂无明确操作</EmptyState>:null}
        {operationRows.length>5&&<button type="button" className="analytics-list-toggle" aria-expanded={allOperations} onClick={()=>{trackAnalyticsExpansion();setAllOperations(value=>!value);}}>{allOperations?'收起操作排行':`显示全部 ${number(operationRows.length)} 项排行`}</button>}
      </section>
    </div>
    <details ref={detailsRef} open={detailsOpen} className="analytics-panel analytics-action-panel">
      <summary onClick={event=>{event.preventDefault();featureAction('analytics','details','admin');setDetailsOpen(value=>!value);}}>操作与结果明细<span>每页 {pageSize} 条 · 默认隐藏系统事件</span></summary>
      {detailsOpen&&<><p className="analytics-footnote">仅筛选下方明细<AnalyticsHelp label="明细筛选" content={analyticsHelp.detailFilters}/></p><div className="analytics-detail-filters">
        <label>功能<select value={filter.feature} onChange={event=>update({feature:event.target.value,action:''})}><option value="">全部功能</option>{featureOptions.map(id=><option key={id} value={id}>{featureLabel(id)}</option>)}</select></label>
        <label>动作<select value={filter.action} onChange={event=>update({action:event.target.value})}><option value="">全部动作</option>{actionsForFeature(filter.feature).map(action=><option key={action} value={action}>{actionLabel(`${filter.feature||'message'}.${action}`,action)}</option>)}</select></label>
        <label>类型<select value={filter.metric} onChange={event=>update({metric:event.target.value,...(event.target.value==='system'?{includeSystem:true}:{})})}><option value="">全部类型</option>{Object.entries(metricLabel).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label><span>结果<AnalyticsHelp label="记录结果" content={analyticsHelp.result}/></span><select value={filter.result} onChange={event=>update({result:event.target.value})}><option value="">全部结果</option>{Object.entries(resultLabel).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label className="analytics-checkbox"><input type="checkbox" checked={filter.includeSystem} onChange={event=>update({includeSystem:event.target.checked,...(!event.target.checked&&filter.metric==='system'?{metric:''}:{})})}/>显示系统事件<AnalyticsHelp label="系统事件" content={analyticsHelp.system}/></label>
        <label>每页条数<select value={pageSize} onChange={event=>{
          const next=detailPageSizes.find(value=>String(value)===event.target.value);
          if(next===undefined||next===pageSize)return;
          featureAction('analytics','paginate','admin');setPageSize(next);
        }}>{detailPageSizes.map(size=><option key={size} value={size}>{size} 条</option>)}</select></label>
        <button type="button" className="analytics-button" onClick={()=>restoreFilter(emptyDetailFilter)}>清除筛选</button>
      </div>{filter.operationId&&<div className="analytics-filter-notice" role="status">
        <span>{actions.error?'这次操作的记录读取失败。':actions.loading||actions.stale?'正在读取这次操作的记录…':`当前范围：${number(actions.data?.items[0]?.operationRecordCount??actions.data?.items.length??0)} 条关联记录。`}</span>
        <button type="button" className="analytics-text-button" onClick={()=>restoreFilter(beforeRelated.current??emptyDetailFilter)}>返回原筛选</button>
      </div>}
      <AnalyticsResourceState resource={actions} label="操作明细"/>
      {actions.data?.items.length?<><div className="analytics-data-table analytics-action-table"><table><colgroup><col className="analytics-col-time"/><col className="analytics-col-feature"/><col className="analytics-col-metric"/><col className="analytics-col-result"/><col/></colgroup><thead><tr><th scope="col">时间</th><th scope="col">功能 / 动作</th><th scope="col">类型</th><th scope="col">结果</th><th scope="col">详情</th></tr></thead><tbody>{actions.data.items.map(row=><tr key={row.id}><td><time dateTime={new Date(row.at).toISOString()}>{beijingTime(row.at)}</time></td><td><strong>{featureLabel(row.feature)}</strong><small>{actionLabel(row.registrationId,row.action)}</small></td><td>{metricLabel[row.metric]??row.metric}</td><td><RowResult row={row}/></td><td>{rowDetails(row)}</td></tr>)}</tbody></table></div>
        <ul className="analytics-action-cards">{actions.data.items.map(row=><li key={row.id}><div><strong>{featureLabel(row.feature)} · {actionLabel(row.registrationId,row.action)}</strong><RowResult row={row}/></div><p>{beijingTime(row.at)} · {metricLabel[row.metric]}</p>{rowDetails(row)}</li>)}</ul></>:!actions.loading&&!actions.error?<EmptyState>当前筛选下暂无记录</EmptyState>:null}
      <div className="analytics-pagination"><span>第 {cursors.length+1} 页{actions.data&&!actions.stale?` · 本页 ${actions.data.items.length} 条`:''}</span>
        <button type="button" className="analytics-button" disabled={actions.loading||!cursors.length} onClick={()=>changePage([])}>回到第一页</button><button type="button" className="analytics-button" disabled={actions.loading||!cursors.length} onClick={()=>changePage(cursors.slice(0,-1))}>上一页</button><button type="button" className="analytics-button" disabled={actions.loading||actions.stale||!actions.data?.next} onClick={()=>{if(actions.data?.next)changePage([...cursors,actions.data.next]);}}>下一页</button>
      </div>
      <p className="analytics-footnote">时间为服务端接收时间（北京时间）。</p></>}
    </details>
  </section>;
}
