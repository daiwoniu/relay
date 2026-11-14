import test from 'node:test';
import assert from 'node:assert/strict';
import { finishStoredAssistant } from './stored-assistant-terminal.js';
import { StoredRuntimeEvents } from '../engine/stored-runtime-events.js';
import { createSessionRuntimeState } from '../engine/runtime.js';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import type { EngineEventEnvelope } from '../engine/events.js';

const event:EngineEventEnvelope={engineId:'codex',payload:{type:'message_complete',turnId:'final-turn',content:'answer',processContent:'  thinking  ',finalAnswerItemId:'final'},
  meta:{source:'realtime',sequence:1,observedAt:100,eventId:'final',externalSessionId:'thread',externalTurnId:'final-turn'}};
async function setup(){
  const f=fixture(),port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const runtime=createSessionRuntimeState({sessionId:'session',projectId:'project',engine:'codex'});
  Object.assign(runtime,{attemptId:'attempt',engineConnectionId:'connection',leaseToken:'lease',currentTurnId:'final-turn',turnStartTime:1000});
  runtime.turnItems=[{id:'reason',type:'reasoning',status:'completed',text:'thinking'},{id:'narrative',type:'agentMessage',status:'completed',text:'answer'}];
  runtime.processTimeline=[{type:'narrative',itemId:'process',content:'thinking'},{type:'narrative',itemId:'final',content:'answer'}];
  runtime.tokenUsage={inputTokens:10,cachedInputTokens:0,outputTokens:4,reasoningOutputTokens:2,totalTokens:14,modelContextWindow:1000};
  runtime.turnModelSnapshot={preferences:{modelId:'synthetic',reasoningEffort:'high'},displayNames:{},modelDefaults:{},defaultModelId:'synthetic',
    modelInfo:{engineId:'codex',effective:{id:'synthetic',displayName:'Synthetic'},rerouted:false}};
  const bound=new StoredRuntimeEvents(runtime,port,{storeId:'store',generation:1,runtimeVersion:1,isOwned:()=>true,onFailure:()=>{}});
  return{f,port,runtime,bound,close:async()=>{await bound.close().catch(()=>{});await port.close();f.cleanup();}};
}
test('actual terminal message adapter preserves process, file, model and usage metadata in Native storage',async()=>{
  const h=await setup();try{await h.bound.route(event,async(captured,context)=>{
    assert.equal(captured.payload.type,'message_complete');if(captured.payload.type!=='message_complete')throw Error('wrong fixture');
    const pending=finishStoredAssistant(h.runtime,captured.payload,context,{messageId:'final-result',now:3000,
      fileChanges:{changedFiles:[{path:'src/example.ts',changeType:'modified',size:6}],changedFilesIncomplete:true}});
    h.runtime.processTimeline=[];h.runtime.tokenUsage!.outputTokens=999;
    const saved=await pending;assert.equal(saved.projection.revision,3);
    const metadata=JSON.parse(saved.projection.savedMessage.metadata!);
    assert.equal(metadata.processContent,'thinking');assert.deepEqual(metadata.processTimeline,[{type:'narrative',itemId:'process',content:'thinking'}]);
    assert.equal(metadata.modelInfo.effective.id,'synthetic');assert.equal(metadata.tokenUsage.outputTokens,4);
    assert.equal(metadata.changedFiles[0].path,'src/example.ts');assert.equal(metadata.changedFilesIncomplete,true);
    assert.equal(saved.projection.savedMessage.durationMs,2000);
    const items=JSON.parse(saved.projection.savedMessage.items!);assert.equal(items.length,1);assert.equal(items[0].id,'reason');
  });assert.equal(h.f.scalar('SELECT status FROM sessions'),'completed');assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
  }finally{await h.close();}
});
test('the actual snapshot adapter cannot substitute content for a different persisted final fact',async()=>{
  const h=await setup();try{await assert.rejects(h.bound.route(event,async(captured,context)=>{
    if(captured.payload.type!=='message_complete')throw Error('wrong fixture');
    await finishStoredAssistant(h.runtime,{...captured.payload,content:'substituted'},context,{messageId:'final-result',now:3000,fileChanges:{}});
  }));assert.equal(h.f.scalar("SELECT count(*) FROM messages WHERE id='final-result'"),0);assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
  }finally{await h.close();}
});
