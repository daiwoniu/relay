import {ANALYTICS_FEATURES,ANALYTICS_REGISTRY,ANALYTICS_TOOL_IDS} from '../../../../server/src/analytics/registry';
import {analyticsName} from './analytics-presentation';
export type FeatureRow={feature:string;views:number;actions:number;failures?:number;results:Record<string,number>};
export type OperationRow={registrationId:string;feature:string;action:string;count:number};
export type FeatureData={features:FeatureRow[];operations:OperationRow[];unrecognized?:number};
export type DetailFilter={feature:string;action:string;result:string;metric:string;includeSystem:boolean;operationId:string};
export const emptyDetailFilter:DetailFilter={feature:'',action:'',result:'',metric:'',includeSystem:false,operationId:''};
export const featureLabel=(id:string)=>id.startsWith('tool.')?`工具 · ${analyticsName(id.slice(5))}`:ANALYTICS_FEATURES[id as keyof typeof ANALYTICS_FEATURES]?.label??id;
const labels=new Map(ANALYTICS_REGISTRY.map(entry=>[entry.id,entry.label]));
const actionNames=new Map(ANALYTICS_REGISTRY.map(entry=>[entry.action,entry.label.split('·').slice(1).join('·')]));
const legacyActions:Record<string,string>={format:'格式化',minify:'压缩',validate:'校验',compare:'对比',calculate:'计算',randomize:'随机生成',read:'阅读外链',start:'开始',complete:'自动完成',export_png:'导出PNG',export_svg:'导出SVG'};
export const actionLabel=(id:string,fallback:string)=>labels.get(id)?.split('·').slice(1).join('·')||actionNames.get(fallback)||legacyActions[fallback]||analyticsName(fallback);
export const resultLabel:Record<string,string>={success:'成功',error:'处理失败',invalid_input:'输入无效',cancelled:'已取消',rejected:'已拒绝',throttled:'已限流',unknown:'未知'};
export const metricLabel:Record<string,string>={view:'功能访问',action:'明确操作',result:'操作结果',system:'系统事件'};
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
export function detailQuery(query:string,filter:DetailFilter,cursor?:{at:number;id:string}){
  const params=new URLSearchParams(query);params.set('includeSystem',String(filter.includeSystem));
  for(const key of ['feature','action','result','metric','operationId'] as const)if(filter[key])params.set(key,filter[key]);
  if(cursor){params.set('beforeAt',String(cursor.at));params.set('beforeId',cursor.id);}
  return params.toString();
}
export function featureTotals(data:FeatureData|null){return(data?.features??[]).reduce((sum,row)=>({actions:sum.actions+row.actions,errors:sum.errors+(row.failures??row.results.error??0)}),{actions:0,errors:0});}
