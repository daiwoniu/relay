import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context } from 'hono';
import type { CoreStoragePort } from '../storage/contracts.js';
import { observeStorageCommands } from '../storage/command-observation.js';
import { getHttpClientIp } from '../http-client-ip.js';
import { getAnalyticsVisitorId } from './cookie.js';
import { commandMeaning } from './command-meaning.js';
import { AnalyticsEventSchema,type AnalyticsRecord } from './contract.js';
import { analyticsLoginId,type AnalyticsService } from './service.js';
import type { AnalyticsReader } from './reader.js';
import type { AnalyticsFeatureProperties } from './registry.js';

const requests=new AsyncLocalStorage<{context:Context;service:AnalyticsService}>();
const services=new WeakMap<object,AnalyticsService>();
export function recordTrustedResult(port:object,actor:{userId:string;role:'member'|'admin'}|{userId:null;role:'guest'},feature:AnalyticsFeatureProperties['feature'],action:string,key:string,operationId?:string,result:AnalyticsFeatureProperties['result']='success',attributes:Pick<AnalyticsFeatureProperties,'engine'|'durationMs'|'reasonCode'>={},page:AnalyticsRecord['event']['page']='chat'){
  if(process.env.RELAY_ANALYTICS_EXTENDED_ENABLED==='0')return;
  try{
    const service=services.get(port);if(!service)return;
    const event=AnalyticsEventSchema.parse({id:analyticsLoginId(`result:${actor.userId}:${key}:${feature}:${action}`),name:'operation_result',page,pageViewId:null,
      referrerHost:null,device:'unknown',browser:'Other',os:'Other',properties:{feature,action,surface:'unknown',operationId:operationId??analyticsLoginId(`${actor.userId}:${key}`),result,...attributes}});
    service.enqueue([service.record(event,{...actor,visitorId:null},null)]);
  }catch{/* Private trusted fact projection only; never a business dependency. */}
}
export function requestAnalyticsOperationId(c:Context|undefined){
  const value=c?.req.header('x-relay-analytics-operation');
  return value&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)?value:undefined;
}
function correlation(c:Context|undefined,fallback:string){return requestAnalyticsOperationId(c)??analyticsLoginId(fallback);}
export function analyticsRequest<T>(c:Context,service:AnalyticsService,run:()=>T){return requests.run({context:c,service},run);}
/** Call only at an explicitly confirmed operation boundary, never in generic HTTP middleware. */
export function recordCommittedOperation(feature:AnalyticsFeatureProperties['feature'],action:string,key:string,result:AnalyticsFeatureProperties['result']='success',details:{page?:AnalyticsRecord['event']['page'];mode?:AnalyticsFeatureProperties['mode'];operationId?:string}={}){
  if(process.env.RELAY_ANALYTICS_EXTENDED_ENABLED==='0')return;
  try{
    const scope=requests.getStore();if(!scope)return;
    const {context:c,service}=scope,actor=c.get('relayActor') as {userId:string;role:'admin'|'member'}|undefined;
    if(!actor)return;
    const operationId=details.operationId??correlation(c,`${actor.userId}:${key}`);
    const event=AnalyticsEventSchema.parse({id:analyticsLoginId(`result:${actor.userId}:${key}:${feature}:${action}`),name:'operation_result',page:details.page??'chat',pageViewId:null,
      referrerHost:null,device:'unknown',browser:'Other',os:'Other',properties:{feature,action,surface:'unknown',operationId,result,...(details.mode?{mode:details.mode}:{})}});
    service.enqueue([service.record(event,{...actor,visitorId:getAnalyticsVisitorId(c.req.header('cookie'))},getHttpClientIp(c),c)]);
  }catch{/* Analytics never changes the operation result. */}
}
/** Observation is outside business transactions and bounded independently of the writer. */
export function collectCommittedAnalytics(port:CoreStoragePort,service:AnalyticsService,reader?:AnalyticsReader){
  services.set(port,service);
  let pending=0,closed=false;
  const detach=observeStorageCommands(port,(request,result)=>{
    if(!service.enabled||process.env.RELAY_ANALYTICS_EXTENDED_ENABLED==='0'||closed)return;
    const meaning=commandMeaning(request,result);if(!meaning)return;
    if(pending>=20){service.observationDropped();return;}
    const context=requests.getStore()?.context;pending++;
    void (async()=>{
      let identity:Pick<AnalyticsRecord,'visitorId'|'userId'|'role'>|null=null;
      if(request.principal.kind==='user'){
        const actor=context?.get('relayActor') as {userId:string;role:'admin'|'member'}|undefined;
        if(actor?.userId===request.principal.userId)identity={...actor,visitorId:getAnalyticsVisitorId(context!.req.header('cookie'))};
        else{
          const session=await port.authenticateSession({tokenHash:request.principal.authSessionHash});
          if(session?.user.id===request.principal.userId)identity={userId:session.user.id,role:session.user.role,visitorId:null};
        }
      }else if(meaning.sessionId&&meaning.decisionId&&reader){
        const actor=await reader.actor(meaning.sessionId,meaning.decisionId);
        if(actor)identity={...actor,visitorId:null};
      }
      if(!identity||closed){if(!closed)service.observationDropped();return;}
      const operationId=correlation(context,meaning.feature==='composer'&&meaning.action==='submit'&&meaning.key?meaning.key:`${identity.userId}:${request.operationId}`);
      const rejection=result.state==='rejected'?{result:result.code==='INVALID_ARGUMENT'?'invalid_input':result.code==='FORBIDDEN'?'rejected':result.code==='OVERLOADED'?'throttled':'error',reasonCode:result.code==='INVALID_ARGUMENT'?'INVALID_INPUT':result.code==='FORBIDDEN'?'PERMISSION_DENIED':result.code==='OVERLOADED'?'RATE_LIMITED':'OPERATION_FAILED'}:{};
      const event=AnalyticsEventSchema.parse({id:analyticsLoginId(`result:${identity.userId}:${meaning.key??request.operationId}:${meaning.feature}:${meaning.action}${result.state==='rejected'?`:${result.code}`:''}`),
        name:'operation_result',page:'chat',pageViewId:null,referrerHost:null,device:'unknown',browser:'Other',os:'Other',
        properties:{feature:meaning.feature,action:meaning.action,surface:'unknown',operationId,result:'success',...meaning.attributes,...rejection}});
      service.enqueue([service.record(event,identity,context?getHttpClientIp(context):null,context)]);
    })().catch(()=>{service.observationDropped();}).finally(()=>{pending--;});
  });
  return()=>{closed=true;detach();if(services.get(port)===service)services.delete(port);};
}
