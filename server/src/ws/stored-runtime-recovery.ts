import type { EngineEvent } from '../engine/adapter.js';
import type { SessionRuntime } from '../engine/runtime.js';
import type { RuntimeStorage } from '../storage/runtime-storage.js';
import { upsertTurnItem,VISIBLE_ITEM_TYPES } from './frontend-protocol.js';
import { insertOperationReference,restoreOperationReferences } from '../process-timeline.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { toAsyncQuestionItem } from '../codex/async-questions.js';
import { presentProcessItem } from '../messages/presenter.js';
import { preserveProcessTiming } from '../messages/process-timing.js';

type Context=Parameters<Parameters<RuntimeStorage['process']>[1]>[1];
/** Only a provider's recovery observation can turn a recovering lease back into running. */
export async function projectStoredRecoverySnapshot(runtime:SessionRuntime,snapshot:Extract<EngineEvent,{type:'recovery_snapshot'}>,context:Context){
  context.guard.assertCurrent();
  if(!context.fact||!context.fact.factType.startsWith('recovery_')||context.fact.source!=='recovery'
    ||runtime.currentTurnId&&runtime.currentTurnId!==snapshot.turnId)throw new StorageContractError('CONFLICT');
  let state:Awaited<ReturnType<Context['persistRecovered']>>|undefined;
  if(snapshot.status==='inProgress')state=await context.persistRecovered({externalTurnId:snapshot.turnId,pendingCount:runtime.pendingInteractions.size,waitingOnInteraction:snapshot.waitingOnInteraction});
  context.guard.assertCurrent();
  runtime.currentTurnId=snapshot.turnId;runtime.requestForwarded=true;
  runtime.currentContent=[snapshot.processContent,snapshot.content].filter(Boolean).join('\n\n');
  runtime.commentaryContent=snapshot.processContent??'';runtime.finalAnswerContent=snapshot.content;runtime.lastFinalAnswerItemId=snapshot.finalAnswerItemId??null;
  const restored:SessionRuntime['turnItems']=[];
  for(const source of snapshot.items){
    const questionSource=toAsyncQuestionItem(source);
    const question=questionSource?preserveProcessTiming(runtime,questionSource):undefined;
    if(question){const item=presentProcessItem(question,'in_progress');if(!item)throw new StorageContractError('CONFLICT');const saved=await context.persistAsyncQuestion({turnId:snapshot.turnId,item});context.guard.assertCurrent();restored.push(saved.value.closedItem??question);}
    else restored.push(preserveProcessTiming(runtime,source));
  }
  // Provider history does not include Relay's authorization records.
  const localInteractions=runtime.turnItems.filter(item=>item.type==='interaction'||runtime.pendingInteractions.has(item.id)
    ||(item.details as Record<string,unknown>|undefined)?.interactionKind==='async_question');
  runtime.turnItems=[...restored,...localInteractions].reduce((items,item)=>upsertTurnItem(items,item),[] as SessionRuntime['turnItems']);
  const previousTimeline=runtime.processTimeline;
  const previousNarratives=new Map(previousTimeline.filter(entry=>entry.type==='narrative').map(entry=>[entry.itemId,entry]));
  const restoredTimeline=snapshot.processTimeline?.length?structuredClone(snapshot.processTimeline).map(entry=>{
    const old=previousNarratives.get(entry.itemId);
    return runtime.engine==='codex'&&entry.type==='narrative'&&old?.firstObservedAt!==undefined?{...entry,firstObservedAt:old.firstObservedAt}:entry;
  }):restored.reduce((timeline,item)=>VISIBLE_ITEM_TYPES.has(item.type)?insertOperationReference(timeline,item.id):timeline,[] as SessionRuntime['processTimeline']);
  runtime.processTimeline=restoreOperationReferences(restoredTimeline,localInteractions.map(item=>item.id),previousTimeline);
  if(state){runtime.turnStartTime=state.value.startedAt;runtime.isRecovering=false;runtime.isStopping=state.value.status==='stopping';}
}
