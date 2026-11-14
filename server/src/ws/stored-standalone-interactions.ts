import { createHash } from 'node:crypto';
import type { EngineInteractionAdapter } from '../engine/facets.js';
import type { EngineEventEnvelope } from '../engine/events.js';
import { completeRuntimeInteraction,type SessionRuntime } from '../engine/runtime.js';
import type { RuntimeStorage } from '../storage/runtime-storage.js';
import { canonicalJson } from '../storage/command-boundary.js';
import { createInteractionItem,createScopedInteractionId,normalizeInteractionOrFallback } from './frontend-interactions.js';
import { upsertTurnItem } from './frontend-protocol.js';
import { insertOperationReference } from '../process-timeline.js';
import { presentProcessItem } from '../messages/presenter.js';
import { publishStoredRuntimeEvent,type StoredStreamOptions } from './stored-runtime-stream.js';
import { respondStoredAutomatically } from './stored-auto-response.js';

type Context=Parameters<Parameters<RuntimeStorage['standaloneEvent']>[0]>[0];
/** A request after a committed terminal owns an independent interaction record. */
export async function projectStoredStandalone(runtime:SessionRuntime,version:number,envelope:EngineEventEnvelope,context:Context,adapter:EngineInteractionAdapter|undefined,options:StoredStreamOptions={}){
  const event=envelope.payload;
  if(event.type!=='server_request'&&event.type!=='server_request_resolved')return;
  context.guard.assertCurrent();if(!['realtime','request_response'].includes(envelope.meta.source))return;
  const scope=`${runtime.engineConnectionId}:standalone:${version}`,id=createScopedInteractionId(scope,event.requestId);
  if(event.type==='server_request'){
    if(runtime.pendingInteractions.has(id)||runtime.settledInteractionIds.has(id))return;
    const request={requestId:event.requestId,method:event.method,params:event.params};
    const interaction=normalizeInteractionOrFallback(adapter,request),item=createInteractionItem(interaction,request.method,scope),createdAt=envelope.meta.observedAt;
    const presented=presentProcessItem(item,'in_progress');if(!presented)throw new Error('INVALID_STANDALONE_ITEM');
    const requestDigest=createHash('sha256').update(canonicalJson({sessionId:runtime.sessionId,attemptId:runtime.attemptId,connectionId:runtime.engineConnectionId,
      version,engine:runtime.engine,interactionId:id,request,interaction,createdAt},1024*1024)).digest('hex');
    await context.begin({interactionId:id,requestDigest,item:presented});context.guard.assertCurrent();
    runtime.pendingInteractions.set(id,{request,interaction,standalone:true,createdAt,connectionId:runtime.engineConnectionId});
    runtime.turnItems=upsertTurnItem(runtime.turnItems,item);runtime.processTimeline=insertOperationReference(runtime.processTimeline,id);
    const completed=await respondStoredAutomatically(runtime,id,adapter,context,requestDigest),output=completed?presentProcessItem(completed,'completed'):presented;
    if(output)await publishStoredRuntimeEvent({type:completed?'item_complete':'item_start',sessionId:runtime.sessionId,item:output},context.guard,options);
  }else{
    if(!runtime.pendingInteractions.get(id)?.standalone)return;
    const resolution={resolvedAction:'resolved_elsewhere' as const,source:'resolved_elsewhere' as const,decidedAt:envelope.meta.observedAt};
    const view={...runtime,turnItems:structuredClone(runtime.turnItems),settledInteractionIds:new Set(runtime.settledInteractionIds)};
    const completed=completeRuntimeInteraction(view,id,resolution),item=completed&&presentProcessItem(completed,'completed');if(!item)throw new Error('INVALID_STANDALONE_ITEM');
    await context.resolve({interactionId:id,item});context.guard.assertCurrent();
    completeRuntimeInteraction(runtime,id,resolution);runtime.pendingInteractions.delete(id);
    await publishStoredRuntimeEvent({type:'item_complete',sessionId:runtime.sessionId,item},context.guard,options);
  }
}
