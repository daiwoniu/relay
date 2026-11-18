import { normalizeAnalyticsEnvironment } from '../../../scripts/lib/client-environment.mjs';
import { classifyAnalyticsSource } from '../../../scripts/lib/analytics-source.mjs';
export { normalizeAnalyticsEnvironment } from '../../../scripts/lib/client-environment.mjs';
import { generateUUID } from '../utils/uuid.ts';
import { collectBasicClientEnvironment } from '../utils/client-environment.ts';
import type { AnalyticsClientEvent,AnalyticsSummary,AnalyticsVisit } from '../../../server/src/analytics/contract';
export type { AnalyticsSummary,AnalyticsVisit };
export type Page=AnalyticsClientEvent['page'];
type ToolAction=Extract<AnalyticsClientEvent,{name:'tool_action'}>['properties'];
type Meta=Pick<AnalyticsClientEvent,'device'|'browser'|'os'|'referrerHost'|'sourceType'|'clientSource'|'clientVersion'>;
export function createTracker(options:{enabled:()=>boolean;send:(body:string,keepalive:boolean)=>Promise<unknown>;meta:()=>Meta;uuid?:()=>string}){
  let queue:AnalyticsClientEvent[]=[],sending=false,page:Page='unknown',pageViewId:string|null=null,identity='',location='',generation=0;
  let navigationKey:string|null=null,pageSource:Pick<Meta,'sourceType'|'referrerHost'>|null=null;
  const uuid=options.uuid??generateUUID;
  function track(name:AnalyticsClientEvent['name'],properties:AnalyticsClientEvent['properties']){
    if(!options.enabled())return;
    try{
      const metadata=options.meta();
      pageSource??={referrerHost:metadata.referrerHost,...(metadata.sourceType?{sourceType:metadata.sourceType}:{})};
      const event={id:uuid(),name,page,pageViewId,...metadata,...pageSource,properties} as AnalyticsClientEvent;
      if(JSON.stringify(properties).length>512)return;
      if(queue.length>=50)queue.shift();queue.push(event);if(queue.length>=20)void flush();
    }catch{/* Analytics must never affect the tool or route. */}
  }
  async function flush(keepalive=false){
    if(!options.enabled()){queue=[];return;}
    if(sending||!queue.length)return;
    const batch:AnalyticsClientEvent[]=[];
    while(queue.length&&batch.length<20){
      const next=queue[0];
      if(new TextEncoder().encode(JSON.stringify({events:[...batch,next]})).length>16*1024){if(!batch.length)queue.shift();break;}
      batch.push(queue.shift()!);
    }
    if(!batch.length)return;
    sending=true;
    try{await options.send(JSON.stringify({events:batch}),keepalive);}catch{/* Best effort; no offline retry. */}
    finally{sending=false;}
  }
  return{track,flush,
    page(next:Page,key:string,user:string){
      if(identity!==user){queue=[];identity=user;location='';}
      if(location===key&&page===next)return;
      if(navigationKey!==null&&navigationKey!==key)pageSource={sourceType:'internal',referrerHost:null};
      navigationKey=key;
      generation++;page=next;location=key;pageViewId=uuid();track('page_view',{});
    },
    reset(){generation++;queue=[];pageViewId=null;location='';identity='';},
    capture(){const current=generation;return()=>current===generation;},
    size:()=>queue.length,
  };
}
export function collectAnalyticsMeta():Meta{
  const e=collectBasicClientEnvironment();let source:Pick<Meta,'sourceType'|'referrerHost'>={referrerHost:null};
  try{source=classifyAnalyticsSource(document.referrer,location.href,typeof __RELAY_SOURCE_ORIGINS__==='undefined'?[]:__RELAY_SOURCE_ORIGINS__);}catch{/* Leave collection failures unrecorded. */}
  return{...normalizeAnalyticsEnvironment(e),...source,clientSource:e.source,clientVersion:e.relayVersion.slice(0,40)};
}
export const tracker=createTracker({
  enabled:()=>typeof window!=='undefined'&&Boolean(import.meta.env?.PROD)&&!(window as Window&{__RELAY_DISABLE_ANALYTICS__?:boolean}).__RELAY_DISABLE_ANALYTICS__,
  meta:collectAnalyticsMeta,send:async(body,keepalive)=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
    try{return await fetch('/api/public/analytics/events',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body,keepalive,signal:controller.signal});}
    finally{clearTimeout(timer);}
  },
});
export function trackToolAction(toolId:ToolAction['toolId'],action:ToolAction['action'],result:ToolAction['result']='success'){
  tracker.track('tool_action',{toolId,action,result,...(result==='invalid_input'?{errorCode:'INVALID_INPUT' as const}:result==='error'?{errorCode:action==='copy'?'COPY_FAILED' as const:action.startsWith('export')?'EXPORT_FAILED' as const:'OPERATION_FAILED' as const}:{})});
}
export function captureToolAction(toolId:ToolAction['toolId'],action:ToolAction['action']){
  const current=tracker.capture();return(result:ToolAction['result']='success')=>{if(current())trackToolAction(toolId,action,result);};
}
