import { createHash } from 'node:crypto';
import type { EngineEventEnvelope } from '../engine/events.js';
import { updateTurnModelSnapshot,type SessionRuntime,type RuntimeTurnItem } from '../engine/runtime.js';
import type { RuntimeStorage } from '../storage/runtime-storage.js';
import { insertOperationReference } from '../process-timeline.js';
import { presentProcessItem } from '../messages/presenter.js';
import { recordProcessTiming } from '../messages/process-timing.js';
import { upsertTurnItem } from './frontend-protocol.js';
import { publishStoredRuntimeEvent,type StoredStreamOptions } from './stored-runtime-stream.js';
type Context=Parameters<Parameters<RuntimeStorage['process']>[1]>[1];
const publishedCompactionCounts=new WeakMap<SessionRuntime,number>();
export async function projectStoredRuntimeNotices(runtime:SessionRuntime,envelope:EngineEventEnvelope,context:Context,options:StoredStreamOptions&{onCompactionCommitted?:()=>Promise<void>}={}):Promise<boolean>{
  const event=envelope.payload;
  if(event.type!=='system_notice'&&!((event.type==='item_start'||event.type==='item_complete')&&event.item.type==='contextCompaction'))return false;
  context.guard.assertCurrent();
  if(!['realtime','request_response'].includes(envelope.meta.source))return true;
  const compacted=event.type==='item_complete'||event.type==='system_notice'&&event.noticeType==='context_compaction';
  if(compacted){
    const explicit=event.type==='system_notice'?event.contextCompaction:('threadId' in event&&'turnId' in event?{threadId:event.threadId,turnId:event.turnId}:undefined);
    const externalSessionId=explicit?.threadId??envelope.meta.externalSessionId;
    const externalTurnId=explicit?.turnId??envelope.meta.externalTurnId;
    if(typeof externalSessionId==='string'&&typeof externalTurnId==='string'){
      const result=await context.persistCompaction({externalSessionId,externalTurnId});context.guard.assertCurrent();
      // Completion items and notices share a receipt. Only the first committed increment changes the ring.
      if(result.value.incremented&&publishedCompactionCounts.get(runtime)!==result.value.count){
        await options.onCompactionCommitted?.();context.guard.assertCurrent();
        publishedCompactionCounts.set(runtime,result.value.count);
      }
    }
  }
  if(event.type==='system_notice'&&event.noticeType==='model_rerouted'&&typeof event.details?.toModel==='string'){
    const model={...runtime.modelInfo,type:'model_info' as const,model:event.details.toModel};
    runtime.modelInfo=model;updateTurnModelSnapshot(runtime,model);
    await publishStoredRuntimeEvent({...model,sessionId:runtime.sessionId},context.guard,options);
  }
  const identity=createHash('sha256').update(JSON.stringify([runtime.attemptId,runtime.engineConnectionId,envelope.meta.source,
    envelope.meta.eventId??envelope.meta.sequence])).digest('hex');
  const status=event.type==='item_start'?'in_progress':'completed';
  const item:RuntimeTurnItem=recordProcessTiming(runtime,event.type!=='system_notice'?{...event.item,status}:{id:`notice:${identity}`,type:'systemNotice',status:'completed',
    details:{...event.details,noticeType:event.noticeType,title:event.title,...(event.message?{message:event.message}:{})}},envelope.meta.observedAt,event.type==='item_start'?'start':event.type==='item_complete'?'complete':'instant');
  runtime.turnItems=upsertTurnItem(runtime.turnItems,item);runtime.processTimeline=insertOperationReference(runtime.processTimeline,item.id);
  const presented=presentProcessItem(item,status);
  if(presented)await publishStoredRuntimeEvent({type:event.type==='item_start'?'item_start':'item_complete',sessionId:runtime.sessionId,item:presented},context.guard,options);
  return true;
}
