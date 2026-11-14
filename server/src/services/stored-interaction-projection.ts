import { randomUUID } from 'node:crypto';
import type { CoreStoragePort,CoreCommandOutputs } from '../storage/contracts.js';
import { operationIdentity,StorageContractError } from '../storage/command-boundary.js';
import { completeRuntimeInteraction } from '../engine/runtime.js';
import { presentProcessItem } from '../messages/presenter.js';
import { publishStoredRuntimeEvent,type StoredStreamOptions } from '../ws/stored-runtime-stream.js';
import type { StoredInteractionResponses } from './stored-interaction-responses.js';
type Submitted=ConstructorParameters<typeof StoredInteractionResponses>[1]['submitted'];

/** Shared active/late protocol-response projection. Repairs the original saved item without clearing newer attempts. */
export function createStoredInteractionProjection(port:CoreStoragePort,options:StoredStreamOptions&{storeId:string;generation:number;
  changed?:(sessionId:string,messageId:string|null)=>Promise<void>}):Submitted{
  return async({binding,pending,command,job,guard:responseGuard})=>{
    const runtime=binding.runtime;
    const settled=()=>!runtime.pendingInteractions.has(command.interactionId)&&runtime.settledInteractionIds.has(command.interactionId);
    const queued=await binding.events.storage.reconcileInteractionProjection(async guard=>{
      guard.assertCurrent();
      // A provider resolution can settle this request while this projection waits
      // behind it. Stale UI work must not fail the authoritative runtime queue.
      if(!responseGuard.isCurrent())return settled();
      const view={...runtime,turnItems:structuredClone(runtime.turnItems),settledInteractionIds:new Set(runtime.settledInteractionIds)};
      const completed=completeRuntimeInteraction(view,command.interactionId,{resolvedAction:command.action,source:'user',decidedAt:0});
      const item=completed&&presentProcessItem(completed,'completed');if(!item)throw new StorageContractError('CONFLICT');
      const request={protocolVersion:1 as const,storeId:options.storeId,workerGeneration:options.generation,requestId:randomUUID(),
        operationId:`interaction-project:${job.jobId}`,principal:{kind:'system' as const,purpose:'maintenance' as const},
        command:{name:'interaction.projectSubmitted' as const,input:{jobId:job.jobId,item,pendingCount:Math.max(0,runtime.pendingInteractions.size-1)}}};
      const result=await port.execute(request);let value:CoreCommandOutputs['interaction.projectSubmitted'];
      if(result.state==='committed')value=result.value;
      else if(result.state==='unknown'){
        const record=await port.lookup({storeId:options.storeId,operationId:request.operationId,principal:request.principal,
          expected:{commandName:request.command.name,inputDigest:operationIdentity(request).inputDigest}});
        if(record.state!=='committed'||record.commandName!=='interaction.projectSubmitted')throw new StorageContractError('STORAGE_UNAVAILABLE');value=record.value;
      }else throw new StorageContractError(result.code);
      guard.assertCurrent();if(!responseGuard.isCurrent())return settled();
      completeRuntimeInteraction(runtime,command.interactionId,{resolvedAction:command.action,source:'user',decidedAt:Number(value.item.details?.decidedAt??0)});
      if(runtime.pendingInteractions.get(command.interactionId)===pending)runtime.pendingInteractions.delete(command.interactionId);
      await publishStoredRuntimeEvent({type:'item_complete',sessionId:runtime.sessionId,item:value.item},guard,options);
      try{await options.changed?.(runtime.sessionId,value.messageId);}catch{/* Committed item stays recoverable by revision. */}
      return true;
    });
    // Report unresolved replacement/mutation outside the queue: it remains
    // projection-pending without blocking subsequent engine facts or stop.
    if(queued.state!=='handled'||!queued.value)throw new StorageContractError('CONFLICT');
  };
}
