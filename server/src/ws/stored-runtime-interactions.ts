import type { EngineInteractionAdapter } from '../engine/facets.js';
import type { EngineEventEnvelope } from '../engine/events.js';
import { completeRuntimeInteraction,type SessionRuntime } from '../engine/runtime.js';
import type { RuntimeStorage } from '../storage/runtime-storage.js';
import { createInteractionItem,createScopedInteractionId,normalizeInteractionOrFallback } from './frontend-interactions.js';
import { upsertTurnItem } from './frontend-protocol.js';
import { insertOperationReference } from '../process-timeline.js';
import { presentProcessItem } from '../messages/presenter.js';
import { recordProcessTiming } from '../messages/process-timing.js';
import { publishStoredRuntimeEvent,type StoredStreamOptions } from './stored-runtime-stream.js';
import { respondStoredAutomatically } from './stored-auto-response.js';
type Context=Parameters<Parameters<RuntimeStorage['process']>[1]>[1];
export async function projectStoredRuntimeInteractions(runtime:SessionRuntime,envelope:EngineEventEnvelope,context:Context,adapter:EngineInteractionAdapter|undefined,options:StoredStreamOptions={}):Promise<boolean>{
  const event=envelope.payload;
  if(event.type!=='server_request'&&event.type!=='server_request_resolved')return false;
  context.guard.assertCurrent();if(!['realtime','request_response'].includes(envelope.meta.source))return true;
  const scope=`${runtime.engineConnectionId}:${runtime.attemptId}`;
  const id=createScopedInteractionId(scope,event.requestId);
  if(event.type==='server_request'){
    if(runtime.pendingInteractions.has(id)||runtime.settledInteractionIds.has(id))return true;
    if(runtime.pendingInteractions.size>=128)throw new Error('RUNTIME_INTERACTION_OVERLOADED');
    const request={requestId:event.requestId,method:event.method,params:event.params};
    const interaction=normalizeInteractionOrFallback(adapter,request),item=recordProcessTiming(runtime,createInteractionItem(interaction,request.method,scope),envelope.meta.observedAt,'start');
    const result=await context.persistInteractions(runtime.pendingInteractions.size+1);context.guard.assertCurrent();
    if(result.value.status==='stopping')runtime.isStopping=true;
    runtime.pendingInteractions.set(id,{request,interaction,standalone:false,createdAt:envelope.meta.observedAt,connectionId:runtime.engineConnectionId});
    runtime.turnItems=upsertTurnItem(runtime.turnItems,item);runtime.processTimeline=insertOperationReference(runtime.processTimeline,id);
    const completed=await respondStoredAutomatically(runtime,id,adapter,context);
    const presented=presentProcessItem(completed??item,completed?'completed':'in_progress');
    if(presented)await publishStoredRuntimeEvent({type:completed?'item_complete':'item_start',sessionId:runtime.sessionId,item:presented},context.guard,options);
  }else{
    if(!runtime.pendingInteractions.has(id))return true;
    await context.persistInteractions(runtime.pendingInteractions.size-1);context.guard.assertCurrent();
    const item=completeRuntimeInteraction(runtime,id,{resolvedAction:'resolved_elsewhere',source:'resolved_elsewhere',decidedAt:envelope.meta.observedAt});
    runtime.pendingInteractions.delete(id);
    if(item){const presented=presentProcessItem(item,'completed');
      if(presented)await publishStoredRuntimeEvent({type:'item_complete',sessionId:runtime.sessionId,item:presented},context.guard,options);}
  }
  return true;
}
