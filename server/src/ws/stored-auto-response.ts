import { createHash,randomUUID } from 'node:crypto';
import type { EngineInteractionAdapter } from '../engine/facets.js';
import { completeRuntimeInteraction,type SessionRuntime } from '../engine/runtime.js';
import type { RuntimeStorage } from '../storage/runtime-storage.js';
import { canonicalJson } from '../storage/command-boundary.js';
type EventContext=Parameters<Parameters<RuntimeStorage['process']>[1]>[1];
type Context=Pick<EventContext,'guard'|'prepareAutoResponse'|'authorizeAutoResponse'|'confirmAutoResponse'>&Partial<Pick<EventContext,'persistInteractions'>>;
const digest=(input:unknown)=>createHash('sha256').update(canonicalJson(input,512*1024)).digest('hex');
function freeze(value:any){if(value&&typeof value==='object'){for(const field of Object.values(value))freeze(field);Object.freeze(value);}return value;}
/** Only a freshly committed Native trust decision can authorize one automatic protocol response. */
export async function respondStoredAutomatically(runtime:SessionRuntime,id:string,adapter:EngineInteractionAdapter|undefined,context:Context,requestDigest?:string){
  const pending=runtime.pendingInteractions.get(id),connection=runtime.engineConnection;
  if(!pending||!connection||!adapter||!pending.interaction.autoApprovable||!pending.interaction.availableActions.includes('accept_once')
    ||!['command','file','permissions'].includes(pending.interaction.kind))return null;
  let response:unknown;
  try{response=freeze(JSON.parse(canonicalJson(adapter.buildResponse(structuredClone(pending.request),{action:'accept_once'}),512*1024)));}
  catch{return null;}
  const prepared=await context.prepareAutoResponse({interactionId:id,requestDigest:requestDigest??digest({request:pending.request,interaction:pending.interaction}),
    responseDigest:digest(response),claimToken:randomUUID(),kind:pending.interaction.kind as 'command'|'file'|'permissions',...(pending.standalone?{standalone:true as const}:{})});
  context.guard.assertCurrent();if(!prepared.value.prepared)return null;
  // Replayed preparation is never a new permission to invoke an external side effect.
  if(prepared.replayed)throw new Error('AUTO_RESPONSE_UNCONFIRMED');
  const job=prepared.value.job,allowed=await context.authorizeAutoResponse(job.jobId);context.guard.assertCurrent();
  if(!allowed.value.allowed)return null;
  if(runtime.pendingInteractions.get(id)!==pending||runtime.engineConnection!==connection)throw new Error('AUTO_RESPONSE_UNCONFIRMED');
  await connection.respondToInteraction(pending.request.requestId,response);
  context.guard.assertCurrent();await context.confirmAutoResponse(job);context.guard.assertCurrent();
  if(!pending.standalone){if(!context.persistInteractions)throw new Error('AUTO_RESPONSE_UNCONFIRMED');await context.persistInteractions(runtime.pendingInteractions.size-1);context.guard.assertCurrent();}
  const item=completeRuntimeInteraction(runtime,id,{resolvedAction:'accept',source:prepared.value.source,expiresAt:prepared.value.expiresAt,decidedAt:Date.now()});
  runtime.pendingInteractions.delete(id);return item;
}
