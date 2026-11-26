import {ANALYTICS_FEATURES,ANALYTICS_REGISTRY,ANALYTICS_TOOL_IDS} from '../../../../server/src/analytics/registry';
import {analyticsName} from './analytics-presentation';
import type {AnalyticsQuery} from '../../../../server/src/analytics/contract';
export type FeatureRow={feature:string;views:number;actions:number;failures?:number;results:Record<string,number>};
export type OperationRow={registrationId:string;feature:string;action:string;count:number};
export type FeatureData={features:FeatureRow[];operations:OperationRow[];messageSubmits?:number;unrecognized?:number};
export type DetailFilter={feature:string;action:string;result:string;metric:string;includeSystem:boolean;operationId:string};
export const emptyDetailFilter:DetailFilter={feature:'',action:'',result:'',metric:'',includeSystem:false,operationId:''};
export const featureLabel=(id:string)=>id.startsWith('tool.')?`工具 · ${analyticsName(id.slice(5))}`:ANALYTICS_FEATURES[id as keyof typeof ANALYTICS_FEATURES]?.label??id;
const labels=new Map(ANALYTICS_REGISTRY.map(entry=>[entry.id,entry.label]));
const actionNames=new Map(ANALYTICS_REGISTRY.map(entry=>[entry.action,entry.label.split('·').slice(1).join('·')]));
const legacyActions:Record<string,string>={format:'格式化',minify:'压缩',validate:'校验',compare:'对比',calculate:'计算',randomize:'随机生成',read:'阅读外链',start:'开始',complete:'自动完成',export_png:'导出PNG',export_svg:'导出SVG'};
export const actionLabel=(id:string,fallback:string)=>labels.get(id)?.split('·').slice(1).join('·')||actionNames.get(fallback)||legacyActions[fallback]||analyticsName(fallback);
export const resultLabel:Record<string,string>={success:'成功',error:'处理失败',invalid_input:'输入无效',cancelled:'已取消',rejected:'已拒绝',throttled:'已限流',unknown:'未知'};
export const metricLabel:Record<string,string>={view:'功能访问',action:'明确操作',result:'操作结果',system:'系统事件'};
export type DetailPageSize=NonNullable<AnalyticsQuery['pageSize']>;
export const detailPageSizes=[10,50,100] as const satisfies readonly DetailPageSize[];
const failureReasons:Record<string,string>={
  INVALID_INPUT:'文件引用或操作参数无效。',UNAVAILABLE:'相关服务暂时不可用。',PERMISSION_DENIED:'权限或授权校验未通过。',
  RATE_LIMITED:'请求触发限流。',NETWORK_ERROR:'请求未完成，可能是连接异常或等待超时。',TIMEOUT:'处理超时。',
  NOT_FOUND:'目标不存在或已移走。',EXPIRED:'授权或操作已过期。',LIMIT_REACHED:'超出容量或处理上限。',
  UNSUPPORTED:'当前预览或操作不支持该格式。',EMPTY_FINAL:'未取得有效的最终输出。',INTERRUPTED:'处理过程已中断。',
  COPY_FAILED:'复制操作失败。',EXPORT_FAILED:'导出操作失败。',LOAD_FAILED:'读取或转换失败，记录中没有更具体的原因。',
  OPERATION_FAILED:'操作未完成，记录中没有更具体的原因。',UNKNOWN:'该记录未采集到具体原因。',
  DOCUMENT_INVALID:'文档内容无法解析，可能损坏或与格式不符。',DOCUMENT_ENCRYPTED:'文档已加密或需要密码，无法在线预览。',
  DOCUMENT_CHANGED:'文件在读取过程中发生了变化。',
};
export function actionFailureDescription(result:string|null,reasonCode?:string){
  return reasonCode?failureReasons[reasonCode]??failureReasons.UNKNOWN:result==='error'?failureReasons.UNKNOWN:null;
}
export const featureOptions=[...Object.keys(ANALYTICS_FEATURES).filter(key=>key!=='analytics'),...ANALYTICS_TOOL_IDS.map(id=>`tool.${id}`)];
export const actionOptions=[...new Set([...ANALYTICS_REGISTRY.map(entry=>entry.action),...Object.keys(legacyActions)])].sort((a,b)=>actionLabel('',a).localeCompare(actionLabel('',b),'zh-CN'));
export function actionsForFeature(feature:string){
  if(!feature)return actionOptions;
  const tool=feature.startsWith('tool.');
  const actions=ANALYTICS_REGISTRY.filter(entry=>entry.feature===(tool?'tools':feature)).map(entry=>entry.action);
  if(tool)actions.push('open',...Object.keys(legacyActions));
  if(feature==='news')actions.push('read');
  return [...new Set(actions)].sort((a,b)=>actionLabel(`${feature}.${a}`,a).localeCompare(actionLabel(`${feature}.${b}`,b),'zh-CN'));
}
export function detailQuery(query:string,filter:DetailFilter,cursor?:{at:number;id:string},pageSize?:DetailPageSize){
  const params=new URLSearchParams(query);params.set('includeSystem',String(filter.includeSystem));
  for(const key of ['feature','action','result','metric','operationId'] as const)if(filter[key])params.set(key,filter[key]);
  if(cursor){params.set('beforeAt',String(cursor.at));params.set('beforeId',cursor.id);}
  if(pageSize!==undefined)params.set('pageSize',String(pageSize));
  return params.toString();
}
export const featureFailureCount=(row:FeatureRow)=>row.failures??row.results.error??0;
export function featureTotals(data:FeatureData|null){
  return(data?.features??[]).reduce((summary,row)=>{
    const count=featureFailureCount(row);
    summary.actions+=row.actions;
    summary.errors+=count;
    if(count>(summary.topFailure?.count??0))summary.topFailure={feature:row.feature,count};
    return summary;
  },{actions:0,errors:0,topFailure:null as {feature:string;count:number}|null});
}
