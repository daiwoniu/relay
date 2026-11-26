import type { nativeQueries } from '../storage/native-queries.js';
import type { AnalyticsQuery } from './contract.js';
import { analyticsBounds } from '../storage/native-analytics.js';
import { analyticsMeaning } from './semantics.js';
import {ANALYTICS_MAX_DURATION,ANALYTICS_REGISTRY,ANALYTICS_ATTRIBUTE_VALUES,ANALYTICS_SURFACES} from './registry.js';
function meaning(event:unknown){try{return analyticsMeaning(event as any);}catch{return null;}}
const actionEvents="name IN ('feature_view','feature_action','operation_result','tool_open','tool_action','news_click')";
const withoutAnalytics="COALESCE(json_extract(properties,'$.feature'),'')<>'analytics'";
const operationIdSql="json_extract(properties,'$.operationId')";
const detailKeys=['surface','engine','settingKey','mode','section','reasonCode','toolId','fileKind','sizeBucket'] as const;

export function readFeatureAnalytics(db:ReturnType<typeof nativeQueries>,query:AnalyticsQuery,view:string,cursor?:{at:number;id:string},now=Date.now()){
  const where=`received_at>=? AND received_at<=? AND page<>'analytics_admin' ${query.excludeAdmin?"AND role<>'admin'":''} ${query.excludeInternal?"AND COALESCE(json_extract(properties,'$.networkType'),'unknown')<>'internal'":''}`;
  const {since,until}=analyticsBounds(query,now);
  const params:any[]=[since,until];
  if(view==='actions'){
    const pageSize=query.pageSize??100;
    const featureSql="CASE WHEN json_extract(properties,'$.toolId') IS NOT NULL THEN 'tool.'||json_extract(properties,'$.toolId') WHEN name='news_click' THEN 'news' ELSE json_extract(properties,'$.feature') END";
    const actionSql="CASE WHEN name='tool_open' THEN 'open' WHEN name='news_click' THEN 'read' ELSE json_extract(properties,'$.action') END";
    const systemEntries=ANALYTICS_REGISTRY.filter(entry=>entry.metric==='system');
    const systemSql=`(COALESCE(json_extract(properties,'$.trigger'),'')='automatic' OR (name='tool_action' AND json_extract(properties,'$.toolId')='pomodoro' AND json_extract(properties,'$.action')='complete') OR ${systemEntries.map(()=>"(name=? AND json_extract(properties,'$.feature')=? AND json_extract(properties,'$.action')=?)").join(' OR ')})`;
    const metricSql=`CASE WHEN ${systemSql} THEN 'system' WHEN name IN ('feature_view','tool_open') THEN 'view' WHEN name='operation_result' THEN 'result' ELSE 'action' END`;
    const systemParams=()=>systemEntries.flatMap(entry=>[entry.name,entry.feature,entry.action]);
    const filters:string[]=[];
    for(const [value,sql] of [[query.feature,featureSql],[query.action,actionSql],[query.result,"json_extract(properties,'$.result')"],[query.operationId,operationIdSql]] as const){if(value){filters.push(`${sql}=?`);params.push(value);}}
    if(query.metric){filters.push(`${metricSql}=?`);params.push(...systemParams(),query.metric);}
    if(query.includeSystem===false){filters.push(`NOT ${systemSql}`);params.push(...systemParams());}
    const scopedActions=`${where} AND ${actionEvents} AND ${withoutAnalytics}`;
    const after=cursor?' AND (received_at<? OR (received_at=? AND id<?))':'';
    if(cursor)params.push(cursor.at,cursor.at,cursor.id);
    const rows=db.all(`SELECT id,received_at AS at,name,page,role,properties FROM analytics_events WHERE ${scopedActions}
      ${filters.length?'AND '+filters.join(' AND '):''} ${after}
      ORDER BY received_at DESC,id DESC LIMIT ?`,[...params,pageSize+1]);
    const items=rows.slice(0,pageSize).flatMap(row=>{
      const properties=JSON.parse(row.properties),projected=meaning({name:row.name,page:row.page,properties});
      const durationMs=Number.isInteger(properties.durationMs)&&properties.durationMs>=0&&properties.durationMs<=ANALYTICS_MAX_DURATION?properties.durationMs:null;
      const details=Object.fromEntries(detailKeys.flatMap(key=>{
        const value=key==='reasonCode'?properties.reasonCode??(row.name==='tool_action'?properties.errorCode:undefined):properties[key];
        const allowed=key==='surface'?ANALYTICS_SURFACES:ANALYTICS_ATTRIBUTE_VALUES[key as keyof typeof ANALYTICS_ATTRIBUTE_VALUES];
        return typeof value==='string'&&(allowed as readonly string[]|undefined)?.includes(value)?[[key,value]]:[];
      }));
      return projected&&!projected.analyticsSelf?[{id:row.id,at:row.at,page:row.page,role:row.role,...projected,metric:projected.automatic?'system':projected.metric,durationMs,details}]:[];
    });
    const ids=[...new Set(items.flatMap(({operationId})=>operationId?[operationId]:[]))];
    const associated=new Map<string,number>();
    if(ids.length){
      // Count across the global scope, like the related view, ignoring local filters and pagination.
      for(const row of db.all(`SELECT ${operationIdSql} AS id,name,page,
        json_extract(properties,'$.feature','$.action','$.toolId') AS dimensions,COUNT(*) AS count
        FROM analytics_events WHERE ${scopedActions} AND ${operationIdSql} IN (${ids.map(()=>'?').join(',')})
        GROUP BY 1,2,3,4`,[since,until,...ids])){
        const [feature,action,toolId]=JSON.parse(row.dimensions);
        const projected=meaning({name:row.name,page:row.page,properties:{feature,action,toolId}});
        if(projected&&!projected.analyticsSelf)associated.set(row.id,(associated.get(row.id)??0)+Number(row.count));
      }
    }
    const last=rows[pageSize-1];
    return{items:items.map(row=>({...row,operationRecordCount:row.operationId?associated.get(row.operationId)??1:null})),next:rows.length>pageSize?{at:last.at,id:last.id}:null};
  }
  const counts=new Map<string,{feature:string;views:number;actions:number;failures:number;results:Record<string,number>}>();
  const operations=new Map<string,{registrationId:string;feature:string;action:string;count:number}>();
  let unrecognized=0;
  // SQL reduces long histories to registered dimensions before any JS projection.
  for(const row of db.all(`SELECT name,json_extract(properties,'$.feature','$.action','$.toolId','$.result','$.trigger') AS dimensions,COUNT(*) AS n
    FROM analytics_events WHERE ${where} AND ${actionEvents}
    GROUP BY name,dimensions`,params)){
    const [feature,action,toolId,result,trigger]=JSON.parse(row.dimensions);
    const projected=meaning({name:row.name,properties:{feature,action,toolId,result,trigger}});
    if(!projected){unrecognized+=Number(row.n);continue;}
    if(projected.analyticsSelf||projected.automatic)continue;
    const item=counts.get(projected.feature)??{feature:projected.feature,views:0,actions:0,failures:0,results:{}};
    if(projected.result==='error')item.failures+=Number(row.n);
    if(projected.metric==='view')item.views+=Number(row.n);
    if(projected.metric==='action')item.actions+=Number(row.n);
    if(projected.metric==='action'){
      const operationKey=JSON.stringify([projected.feature,projected.registrationId]);
      const operation=operations.get(operationKey)??{registrationId:projected.registrationId,feature:projected.feature,action:projected.action,count:0};
      operation.count+=Number(row.n);operations.set(operationKey,operation);
    }
    if(projected.metric==='result'&&projected.result)item.results[projected.result]=(item.results[projected.result]??0)+Number(row.n);
    counts.set(projected.feature,item);
  }
  const messageSubmits=operations.get(JSON.stringify(['composer','composer.submit']))?.count??0;
  return{features:[...counts.values()].sort((a,b)=>(b.views+b.actions)-(a.views+a.actions)),operations:[...operations.values()].sort((a,b)=>b.count-a.count).slice(0,20),messageSubmits,retention:'all',sampled:false,unrecognized};
}
