import { normalizeAnalyticsEnvironment } from '../../../scripts/lib/client-environment.mjs';
import { classifyAnalyticsSource } from '../../../scripts/lib/analytics-source.mjs';
export { normalizeAnalyticsEnvironment } from '../../../scripts/lib/client-environment.mjs';
import { generateUUID } from '../utils/uuid.ts';
import { collectBasicClientEnvironment } from '../utils/client-environment.ts';
import { findAnalyticsRegistration,type AnalyticsFeatureProperties } from '../../../server/src/analytics/registry.ts';
import { isExtendedEvent,validClientProperties } from './tracker-validation.ts';
import type { AnalyticsClientEvent,AnalyticsSummary,AnalyticsVisit } from '../../../server/src/analytics/contract';
export type { AnalyticsSummary,AnalyticsVisit };
export type Page=AnalyticsClientEvent['page'];
type EventName=AnalyticsClientEvent['name'];
type Properties<N extends EventName>=Extract<AnalyticsClientEvent,{name:N}>['properties'];
type ToolAction=Properties<'tool_action'>;
type Meta=Pick<AnalyticsClientEvent,'device'|'browser'|'os'|'referrerHost'|'sourceType'|'clientSource'|'clientVersion'>;
type Context=Meta & {page:Page;pageViewId:string|null};
type Queued={json:string;bytes:number;priority:number;extended:boolean};
type Quality={generated:number;overflow:number;invalid:number;sent:number;rejected:number;networkFailed:number};
type Result=NonNullable<AnalyticsFeatureProperties['result']>;
const encoder=new TextEncoder(),batchLimit=16*1024,envelopeBytes=encoder.encode('{"events":[]}').length;
const cleanQuality=():Quality=>({generated:0,overflow:0,invalid:0,sent:0,rejected:0,networkFailed:0});

export function createTracker(options:{
  enabled:()=>boolean;extendedEnabled?:()=>boolean;
  send:(body:string,keepalive:boolean,signal?:AbortSignal)=>Promise<unknown>;
  meta:()=>Meta;uuid?:()=>string;now?:()=>number;
}){
  let queue:Queued[]=[],page:Page|null='unknown',pageViewId:string|null=null,identity='',location='';
  let identityEpoch=0,ready=true,navigationKey:string|null=null,cachedMeta:Meta|null=null;
  let suspendedLocation='';
  let pageSource:Pick<Meta,'sourceType'|'referrerHost'>|null=null,quality=cleanQuality();
  let sending:{controller:AbortController;promise:Promise<void>}|null=null,pendingKeepalive=false;
  const views=new WeakMap<object,{epoch:number;key:string}>();
  const contextListeners=new Set<()=>void>();
  const notifyContext=()=>{for(const listener of contextListeners){try{listener();}catch{/* Collection never changes navigation. */}}};
  const uuid=options.uuid??generateUUID,now=options.now??(()=>performance.now());
  const bump=(key:keyof Quality,count=1)=>{quality[key]=Math.min(2_147_483_647,quality[key]+count);};
  function enabled(extended=false){
    try{return ready&&options.enabled()&&(!extended||Boolean(options.extendedEnabled?.()));}catch{return false;}
  }
  function context():Context {
    if(!cachedMeta){
      const m=options.meta();
      cachedMeta={device:m.device,browser:m.browser,os:m.os,referrerHost:m.referrerHost,
        ...(m.sourceType?{sourceType:m.sourceType}:{}),...(m.clientSource?{clientSource:m.clientSource}:{}),
        ...(m.clientVersion?{clientVersion:m.clientVersion}:{})};
    }
    pageSource??={referrerHost:cachedMeta.referrerHost,...(cachedMeta.sourceType?{sourceType:cachedMeta.sourceType}:{})};
    return {...cachedMeta,...pageSource,page:page??'unknown',pageViewId};
  }
  function invalidate(){
    identityEpoch++;queue=[];cachedMeta=null;quality=cleanQuality();pendingKeepalive=false;
    sending?.controller.abort();
  }
  function enqueue<N extends EventName>(name:N,properties:Properties<N>,captured?:Context,epoch=identityEpoch):boolean {
    if(epoch!==identityEpoch||!enabled(isExtendedEvent(name)))return false;
    try{
      if(!properties||typeof properties!=='object'||Array.isArray(properties)){bump('invalid');return false;}
      const copied={...properties};
      if(!validClientProperties(name,copied)||encoder.encode(JSON.stringify(copied)).length>512){bump('invalid');return false;}
      const event={id:uuid(),name,...(captured??context()),properties:copied};
      const json=JSON.stringify(event),bytes=encoder.encode(json).length;
      if(bytes+envelopeBytes>batchLimit){bump('invalid');return false;}
      const p=copied as Record<string,unknown>;
      const priority=name==='operation_result'||p.result==='error'||p.result==='invalid_input'?2
        :name==='feature_action'||name==='tool_action'||name==='news_click'?1:0;
      bump('generated');
      if(queue.length>=50){
        let lowest=0;
        for(let i=1;i<queue.length;i++)if(queue[i].priority<queue[lowest].priority)lowest=i;
        bump('overflow');
        if(priority<queue[lowest].priority)return false;
        queue.splice(lowest,1);
      }
      queue.push({json,bytes,priority,extended:isExtendedEvent(name)});
      if(queue.length>=20)void flush();
      return true;
    }catch{bump('invalid');return false;}
  }
  function flush(keepalive=false):Promise<void>{
    if(!enabled()){queue=[];sending?.controller.abort();return Promise.resolve();}
    if(!enabled(true))queue=queue.filter(item=>!item.extended);
    if(sending){if(keepalive&&queue.length)pendingKeepalive=true;return sending.promise;}
    if(!queue.length)return Promise.resolve();
    const batch:Queued[]=[];
    let bytes=envelopeBytes;
    while(queue.length&&batch.length<20){
      const next=queue[0],separator=batch.length?1:0;
      if(bytes+separator+next.bytes>batchLimit)break;
      batch.push(queue.shift()!);bytes+=separator+next.bytes;
    }
    const body='{"events":['+batch.map(item=>item.json).join(',')+']}',epoch=identityEpoch;
    const controller=new AbortController();
    const current={controller,promise:Promise.resolve()};
    sending=current;
    let success=false;
    current.promise=(async()=>{
      try{
        const response=await options.send(body,keepalive,controller.signal);
        if(epoch!==identityEpoch)return;
        if(response&&typeof response==='object'&&'ok'in response&&response.ok===false)bump('rejected',batch.length);
        else {bump('sent',batch.length);success=true;}
      }catch{if(epoch===identityEpoch)bump('networkFailed',batch.length);}
      finally{
        if(sending===current)sending=null;
        const keep=pendingKeepalive;pendingKeepalive=false;
        if(queue.length&&(keep||(success&&queue.length>=20)))void flush(keep);
      }
    })();
    return current.promise;
  }
  function capture(){
    const epoch=identityEpoch;
    let snapshot:Context|undefined;
    try{if(enabled())snapshot=context();}catch{/* A failed metadata read cannot affect an operation. */}
    const current=()=>epoch===identityEpoch&&enabled();
    return Object.assign(current,{
      track:<N extends EventName>(name:N,properties:Properties<N>)=>snapshot!==undefined&&enqueue(name,properties,snapshot,epoch),
    });
  }
  function view(properties:Omit<AnalyticsFeatureProperties,'action'> & {action?:string},instance:object):boolean {
    if(!instance||(typeof instance!=='object'&&typeof instance!=='function'))return false;
    try{
      const key=`${properties.feature}:${properties.action??'open'}`,previous=views.get(instance);
      if(previous?.epoch===identityEpoch&&previous.key===key)return false;
      if(!enqueue('feature_view',{...properties,action:properties.action??'open'}))return false;
      views.set(instance,{epoch:identityEpoch,key});return true;
    }catch{return false;}
  }
  function captureResult(properties:Omit<AnalyticsFeatureProperties,'result'|'durationMs'|'operationId'> & {operationId?:string}):(result:Result,details?:Pick<AnalyticsFeatureProperties,'reasonCode'>)=>boolean {
    try{
      if(!enabled(true))return()=>false;
      const input={...properties},captured=capture(),operationId=input.operationId??uuid(),started=now();
      let settled=false;
      return (result:Result,details:Pick<AnalyticsFeatureProperties,'reasonCode'>={})=>{
        if(settled)return false;settled=true;
        try{
          const elapsed=Math.round(now()-started),entry=findAnalyticsRegistration('operation_result',input.feature,input.action);
          return captured.track('operation_result',{
            ...input,...details,operationId,result,
            ...(entry?.attributes.includes('durationMs')&&elapsed>=0&&elapsed<=86_400_000?{durationMs:elapsed}:{}),
          });
        }catch{return false;}
      };
    }catch{return()=>false;}
  }
  return{
    track:<N extends EventName>(name:N,properties:Properties<N>)=>enqueue(name,properties),flush,capture,view,captureResult,
    action:(properties:AnalyticsFeatureProperties)=>enqueue('feature_action',properties),
    result:(properties:AnalyticsFeatureProperties)=>enqueue('operation_result',properties),
    endView:(instance:object)=>{views.delete(instance);},
    subscribeContext:(listener:()=>void)=>{contextListeners.add(listener);return()=>{contextListeners.delete(listener);};},
    page(next:Page|null,key:string,user:string){
      if(identity!==user){invalidate();identity=user;location='';}
      ready=true;
      // Feishu uses route query changes for in-page tabs and filters.
      const sameFeishuView=next==='feishu_bots'&&location!=='';
      if(page===next&&(location===key||sameFeishuView)){notifyContext();return;}
      if(navigationKey!==null&&navigationKey!==key)pageSource={sourceType:'internal',referrerHost:null};
      navigationKey=key;page=next;location=key;
      pageViewId=null;
      if(next!==null){
        try{pageViewId=uuid();}catch{/* An unavailable ID must not stop navigation. */}
        enqueue('page_view',{});
      }
      notifyContext();
    },
    reset(){invalidate();ready=false;suspendedLocation=location;location='';},
    resume(user:string){if(!ready&&identity===user){ready=true;location=suspendedLocation;notifyContext();}},
    size:()=>queue.length,
    quality:()=>({...quality}),
  };
}
export function collectAnalyticsMeta():Meta{
  const e=collectBasicClientEnvironment();let source:Pick<Meta,'sourceType'|'referrerHost'>={referrerHost:null};
  try{source=classifyAnalyticsSource(document.referrer,location.href,typeof __RELAY_SOURCE_ORIGINS__==='undefined'?[]:__RELAY_SOURCE_ORIGINS__);}catch{/* Leave collection failures unrecorded. */}
  return{...normalizeAnalyticsEnvironment(e),...source,clientSource:e.source,clientVersion:e.relayVersion.slice(0,40)};
}
export async function sendAnalytics(body:string,keepalive:boolean,parent?:AbortSignal){
  const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,5000);
  if(parent?.aborted)abort();else parent?.addEventListener('abort',abort,{once:true});
  try{return await fetch('/api/public/analytics/events',{
    method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body,keepalive,signal:controller.signal,
  });}finally{clearTimeout(timer);parent?.removeEventListener('abort',abort);}
}
export const tracker=createTracker({
  enabled:()=>typeof window!=='undefined'&&Boolean(import.meta.env?.PROD)&&!(window as Window&{__RELAY_DISABLE_ANALYTICS__?:boolean}).__RELAY_DISABLE_ANALYTICS__,
  extendedEnabled:()=>import.meta.env?.VITE_RELAY_EXTENDED_ANALYTICS!=='0'&&(window as Window&{__RELAY_ENABLE_EXTENDED_ANALYTICS__?:boolean}).__RELAY_ENABLE_EXTENDED_ANALYTICS__!==false,
  meta:collectAnalyticsMeta,send:sendAnalytics,
});
function toolProperties(toolId:ToolAction['toolId'],action:ToolAction['action'],result:ToolAction['result']):ToolAction {
  return{toolId,action,result,...(result==='invalid_input'?{errorCode:'INVALID_INPUT' as const}:result==='error'?{errorCode:action==='copy'?'COPY_FAILED' as const:action.startsWith('export')?'EXPORT_FAILED' as const:'OPERATION_FAILED' as const}:{})};
}
export function trackToolAction(toolId:ToolAction['toolId'],action:ToolAction['action'],result:ToolAction['result']='success'){
  tracker.track('tool_action',toolProperties(toolId,action,result));
}
export function captureToolAction(toolId:ToolAction['toolId'],action:ToolAction['action']){
  const captured=tracker.capture();let settled=false;
  return(result:ToolAction['result']='success')=>{if(!settled){settled=true;captured.track('tool_action',toolProperties(toolId,action,result));}};
}
