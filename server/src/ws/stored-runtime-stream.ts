import type { EngineEventEnvelope } from '../engine/events.js';
import type { SessionRuntime } from '../engine/runtime.js';
import { appendNarrativeDelta, insertOperationReference } from '../process-timeline.js';
import { presentProcessItem } from '../messages/presenter.js';
import { recordProcessTiming } from '../messages/process-timing.js';
import { upsertTurnItem, VISIBLE_ITEM_TYPES } from './frontend-protocol.js';
import type { StoredFrontendHub } from './stored-frontend-hub.js';

type Guard = {isCurrent:()=>boolean;assertCurrent:()=>void};
type PublishEvent = Parameters<StoredFrontendHub['broadcastSession']>[0];
const seenEvents=new WeakMap<SessionRuntime,Set<string>>();
export interface StoredStreamOptions {
  hub?: Pick<StoredFrontendHub,'broadcastSession'>;
  onPublishFailure?: (code:'RUNTIME_STREAM_PUBLISH_FAILED')=>void;
  onMessageSaved?:(message:import('../storage/contracts.js').StoredMessage,revision:number,guard:Guard)=>Promise<void>;
}

/** Called inside the Native runtime queue, after required facts/start receipts. Never touches legacy storage or hubs. */
export async function projectStoredRuntimeStream(runtime:SessionRuntime,envelope:EngineEventEnvelope,guard:Guard,options:StoredStreamOptions={}):Promise<boolean> {
  const event=envelope.payload;
  const tool=(event.type==='item_start'||event.type==='item_complete')
    &&!['interaction','contextCompaction','systemNotice'].includes(event.item.type);
  if(!tool&&!['delta','request_forwarded','turn_start'].includes(event.type))return false;
  guard.assertCurrent();
  if(envelope.meta.source!=='realtime'&&envelope.meta.source!=='request_response')return true;
  const identity=`${envelope.meta.source}:${event.type}:${envelope.meta.eventId??envelope.meta.sequence}`;
  let seen=seenEvents.get(runtime);if(!seen){seen=new Set();seenEvents.set(runtime,seen);}
  if(seen.has(identity))return true;
  seen.add(identity);if(seen.size>512)seen.delete(seen.values().next().value!);
  let publication:PublishEvent|undefined;
  if(event.type==='delta'){
    const timelineLength=runtime.processTimeline.length;
    runtime.currentContent+=event.content;
    if(event.phase==='commentary'||event.phase==='final_answer'){
      const id=event.itemId||event.phase;
      runtime.processTimeline=appendNarrativeDelta(runtime.processTimeline,id,event.content,runtime.engine==='codex'?envelope.meta.observedAt:undefined);
      if(event.phase==='final_answer'){runtime.lastFinalAnswerItemId=id;runtime.finalAnswerContent+=event.content;}
      else runtime.commentaryContent+=event.content;
    }
    publication={...event,sessionId:runtime.sessionId,...(runtime.engine==='codex'&&runtime.processTimeline.length>timelineLength?{observedAt:envelope.meta.observedAt}:{})};
  }else if(tool&&(event.type==='item_start'||event.type==='item_complete')){
    runtime.turnItems=upsertTurnItem(runtime.turnItems,recordProcessTiming(runtime,{...event.item,status:event.item.status??(event.type==='item_start'?'in_progress':'completed')},envelope.meta.observedAt,event.type==='item_start'?'start':'complete'));
    if(event.item.id&&VISIBLE_ITEM_TYPES.has(event.item.type))runtime.processTimeline=insertOperationReference(runtime.processTimeline,event.item.id);
    // Publish the merged snapshot, matching reconnect/final snapshots rather than losing partial tool fields.
    const merged=runtime.turnItems.find(item=>item.id===event.item.id)!;
    const item=presentProcessItem(merged,event.type==='item_start'?'in_progress':'completed');
    if(item)publication={type:event.type,sessionId:runtime.sessionId,item};
  }else if(event.type==='request_forwarded'){
    runtime.requestForwarded=true;publication={type:'request_forwarded',sessionId:runtime.sessionId};
  }else if(event.type==='turn_start'){
    publication={type:'turn_start',sessionId:runtime.sessionId,turnId:event.turnId};
  }
  if(publication)await publishStoredRuntimeEvent(publication,guard,options);
  // start already committed in StoredRuntimeEvents; its remaining queue/session publications stay with the caller.
  return event.type!=='turn_start';
}

export async function publishStoredRuntimeEvent(publication:PublishEvent,guard:Guard,options:StoredStreamOptions){
  if(options.hub){
    guard.assertCurrent();
    try{
      const result=await options.hub.broadcastSession(publication,{isCurrent:guard.isCurrent});
      if(result.failed)try{options.onPublishFailure?.('RUNTIME_STREAM_PUBLISH_FAILED');}catch{/* Diagnostics only. */}
    }catch{
      try{options.onPublishFailure?.('RUNTIME_STREAM_PUBLISH_FAILED');}catch{/* Diagnostics only. */}
    }
    guard.assertCurrent();
  }
}
