import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRuntimeState } from '../engine/runtime.js';
import type { EngineEventEnvelope } from '../engine/events.js';
import type { EngineEvent } from '../engine/adapter.js';
import { projectStoredRuntimeStream } from './stored-runtime-stream.js';

function harness(){
  const runtime=createSessionRuntimeState({sessionId:'session',projectId:'project',engine:'codex'});
  let current=true,sequence=0;const events:unknown[]=[];
  const guard={isCurrent:()=>current,assertCurrent:()=>{assert.ok(current,'stale runtime');}};
  const envelope=(payload:EngineEvent):EngineEventEnvelope=>({engineId:'codex',payload,meta:{source:'realtime',sequence:++sequence,observedAt:123}});
  const hub={broadcastSession:async(event:unknown)=>{events.push(structuredClone(event));return{sent:1,failed:0};}};
  const project=(payload:EngineEvent)=>projectStoredRuntimeStream(runtime,envelope(payload),guard,{hub});
  return{runtime,events,guard,envelope,hub,project,retire:()=>{current=false;}};
}

test('首次叙事时间仅随首包发送，后续token不重复携带时间字段',async()=>{
  const h=harness();
  await h.project({type:'delta',itemId:'text',phase:'commentary',content:''});
  await h.project({type:'delta',itemId:'text',phase:'commentary',content:'content'});
  assert.equal((h.events[0] as any).observedAt,123);
  assert.equal((h.events[1] as any).observedAt,undefined);
  assert.equal((h.runtime.processTimeline[0] as any).firstObservedAt,123);
});
test('Native narrative projection preserves phases and suppresses duplicate envelopes',async()=>{
  const h=harness();
  await h.project({type:'delta',itemId:'process',phase:'commentary',content:'thinking'});
  const final=h.envelope({type:'delta',itemId:'answer',phase:'final_answer',content:'answer'});
  await projectStoredRuntimeStream(h.runtime,final,h.guard,{hub:h.hub});
  await projectStoredRuntimeStream(h.runtime,final,h.guard,{hub:h.hub});
  assert.equal(h.runtime.currentContent,'thinkinganswer');assert.equal(h.runtime.commentaryContent,'thinking');
  assert.equal(h.runtime.finalAnswerContent,'answer');assert.equal(h.runtime.lastFinalAnswerItemId,'answer');
  assert.equal((h.runtime.processTimeline[0] as any).firstObservedAt,123);
  assert.equal((h.events[0] as any).observedAt,123);
  assert.equal(h.events.length,2);assert.equal(h.runtime.processTimeline.length,2);
});
test('tool updates merge partial fields and publish the same completed snapshot kept for terminal',async()=>{
  const h=harness();
  await h.project({type:'item_start',item:{id:'tool',type:'commandExecution',status:'in_progress',details:{command:'echo test'}}});
  await h.project({type:'item_complete',item:{id:'tool',type:'commandExecution',status:'completed',details:{output:'test'}}});
  assert.equal(h.runtime.turnItems.length,1);assert.equal(h.runtime.processTimeline.length,1);
  assert.equal(h.runtime.turnItems[0]!.status,'completed');
  const sent=h.events[1] as any;assert.equal(sent.item.details.command,'echo test');assert.equal(sent.item.details.output,'test');
  assert.equal(sent.item.details.firstObservedAt,123);assert.equal(sent.item.details.startedObservedAt,123);assert.equal(sent.item.details.completedObservedAt,123);
});
test('ordinary agent message items retain their snapshot without becoming tools or failing the turn',async()=>{
  const h=harness();
  assert.equal(await h.project({type:'item_start',item:{id:'text',type:'agentMessage',status:'in_progress',details:{text:'partial'}}}),true);
  assert.equal(await h.project({type:'item_complete',item:{id:'text',type:'agentMessage',status:'completed',details:{text:'complete'}}}),true);
  assert.equal(h.runtime.turnItems.length,1);assert.equal(h.runtime.turnItems[0]!.status,'completed');
  assert.equal(h.runtime.processTimeline.length,0);assert.equal(h.events.length,2);
  assert.equal((h.events[1] as any).item.type,'agentMessage');
  assert.equal(await h.project({type:'item_complete',item:{id:'approval',type:'interaction',status:'completed'}}),false);
});
test('historical stream is ignored and nonstream events stay with the remaining Native graph',async()=>{
  const h=harness();const old=h.envelope({type:'delta',itemId:'old',content:'replay'});old.meta.source='recovery';
  assert.equal(await projectStoredRuntimeStream(h.runtime,old,h.guard,{hub:h.hub}),true);
  assert.equal(h.runtime.currentContent,'');assert.equal(h.events.length,0);
  assert.equal(await h.project({type:'message_complete',turnId:'turn',content:'final'}),false);
});
test('publication failure preserves the projected snapshot and reports only a fixed diagnostic',async()=>{
  const h=harness(),diagnostics:string[]=[];
  await projectStoredRuntimeStream(h.runtime,h.envelope({type:'delta',content:'kept',itemId:'text'}),h.guard,{
    hub:{broadcastSession:async()=>{throw Error('private socket details');}},onPublishFailure:code=>{diagnostics.push(code);}});
  assert.equal(h.runtime.currentContent,'kept');assert.deepEqual(diagnostics,['RUNTIME_STREAM_PUBLISH_FAILED']);
});
test('retired runtime cannot mutate or publish',async()=>{
  const h=harness();h.retire();await assert.rejects(h.project({type:'delta',content:'old',itemId:'text'}));
  assert.equal(h.runtime.currentContent,'');assert.equal(h.events.length,0);
});
