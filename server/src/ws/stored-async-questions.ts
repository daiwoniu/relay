import type { EngineEventEnvelope } from '../engine/events.js';
import type { SessionRuntime } from '../engine/runtime.js';
import type { RuntimeStorage } from '../storage/runtime-storage.js';
import { toAsyncQuestionItem } from '../codex/async-questions.js';
import { presentProcessItem } from '../messages/presenter.js';
import { recordProcessTiming } from '../messages/process-timing.js';
import { upsertTurnItem } from './frontend-protocol.js';
import { insertOperationReference,removeNarrativeItem } from '../process-timeline.js';
import { publishStoredRuntimeEvent,type StoredStreamOptions } from './stored-runtime-stream.js';
type Context=Pick<Parameters<Parameters<RuntimeStorage['process']>[1]>[1],'guard'|'persistAsyncQuestion'>;
export async function projectStoredAsyncQuestion(runtime:SessionRuntime,envelope:EngineEventEnvelope,context:Context,options:StoredStreamOptions={}){
  const event=envelope.payload;if(runtime.engine!=='codex'||(event.type!=='item_start'&&event.type!=='item_complete'))return false;
  const rawQuestion=toAsyncQuestionItem(event.item);if(!rawQuestion)return false;
  context.guard.assertCurrent();if(!['realtime','request_response'].includes(envelope.meta.source))return true;
  const question=recordProcessTiming(runtime,rawQuestion,envelope.meta.observedAt,'start');
  const turnId=envelope.meta.externalTurnId??runtime.currentTurnId;
  const item=presentProcessItem(question,'in_progress');if(!turnId||!item)throw new Error('ASYNC_QUESTION_UNCONFIRMED');
  const result=await context.persistAsyncQuestion({turnId,item});context.guard.assertCurrent();
  if(result.value.savedMessage&&options.onMessageSaved){
    try{await options.onMessageSaved(result.value.savedMessage,result.value.revision,context.guard);}catch{options.onPublishFailure?.('RUNTIME_STREAM_PUBLISH_FAILED');}
    context.guard.assertCurrent();
  }
  if(!result.value.open)return true;
  runtime.turnItems=upsertTurnItem(runtime.turnItems,question);
  runtime.processTimeline=insertOperationReference(removeNarrativeItem(runtime.processTimeline,event.item.id),question.id);
  await publishStoredRuntimeEvent({type:'item_start',sessionId:runtime.sessionId,item},context.guard,options);return true;
}
