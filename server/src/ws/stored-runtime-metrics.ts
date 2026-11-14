import type { EngineEventEnvelope } from '../engine/events.js';
import { updateTurnModelSnapshot,type SessionRuntime } from '../engine/runtime.js';
import type { RuntimeStorage } from '../storage/runtime-storage.js';
import { accumulateTurnOutputUsage } from '../token-usage-accumulator.js';
import { publishStoredRuntimeEvent,type StoredStreamOptions } from './stored-runtime-stream.js';

type Context=Parameters<Parameters<RuntimeStorage['process']>[1]>[1];
/** Metrics share the ordered Native event queue. Persist both usage projections before publication. */
export async function projectStoredRuntimeMetrics(runtime:SessionRuntime,envelope:EngineEventEnvelope,context:Context,options:StoredStreamOptions={}):Promise<boolean>{
  const event=envelope.payload;
  if(event.type!=='model_info'&&event.type!=='token_usage'&&event.type!=='capacity_observation')return false;
  context.guard.assertCurrent();
  if(envelope.meta.source!=='realtime'&&envelope.meta.source!=='request_response')return true;
  if(event.type==='capacity_observation'){
    await context.persistCapacity(event.observation);context.guard.assertCurrent();
  }else if(event.type==='model_info'){
    runtime.modelInfo=event;updateTurnModelSnapshot(runtime,event);
    await publishStoredRuntimeEvent({...event,sessionId:runtime.sessionId},context.guard,options);
  }else{
    const accumulated=accumulateTurnOutputUsage(runtime.latestTokenUsage,runtime.tokenUsage,event.usage);
    const result=await context.persistUsage({...accumulated},{...event.usage});
    context.guard.assertCurrent();
    if(!result.value.updated)throw new Error('RUNTIME_USAGE_UNCONFIRMED');
    runtime.latestTokenUsage=event.usage;runtime.tokenUsage=accumulated;
    await publishStoredRuntimeEvent({type:'token_usage',sessionId:runtime.sessionId,usage:event.usage,
      currentTurn:true,turnOutputUsage:accumulated},context.guard,options);
  }
  return true;
}
