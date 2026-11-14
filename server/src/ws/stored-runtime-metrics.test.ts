import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StoredRuntimeEvents } from '../engine/stored-runtime-events.js';
import { createSessionRuntimeState,prepareClaimedSessionRuntime } from '../engine/runtime.js';
import { projectStoredRuntimeMetrics } from './stored-runtime-metrics.js';
import { projectStoredRuntimeNotices } from './stored-runtime-notices.js';
import type { EngineEvent } from '../engine/adapter.js';
const usage=(outputTokens:number)=>({inputTokens:100,cachedInputTokens:0,outputTokens,reasoningOutputTokens:1,totalTokens:100+outputTokens,modelContextWindow:200000});
async function setup(){
  const f=fixture(),port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const runtime=createSessionRuntimeState({sessionId:'session',projectId:'project',engine:'codex'});
  prepareClaimedSessionRuntime(runtime,{projectId:'project',attemptId:'attempt',leaseToken:'lease',resourceKey:'codex:default',requestedByUserId:'owner',claimedAt:123,
    preferences:{modelId:'requested',reasoningEffort:'high'},displayNames:{actual:'Actual'}});
  runtime.engineConnectionId='connection';const failures:string[]=[],published:any[]=[],compactionUpdates:number[]=[];let sequence=0;
  const bound=new StoredRuntimeEvents(runtime,port,{storeId:'store',generation:1,runtimeVersion:1,isOwned:()=>true,onFailure:code=>{failures.push(code);}});
  const route=(payload:EngineEvent,source:'realtime'|'request_response'|'recovery'='realtime')=>bound.route({engineId:'codex',payload,meta:{source,sequence:++sequence,observedAt:123,externalSessionId:'thread',externalTurnId:'turn'}},async(event,context)=>{
    const options={onCompactionCommitted:async()=>{compactionUpdates.push(Number(f.scalar('SELECT context_compaction_count FROM sessions')));},hub:{broadcastSession:async(e:Parameters<import('./stored-frontend-hub.js').StoredFrontendHub['broadcastSession']>[0])=>{
      if(e.type==='token_usage')assert.equal(JSON.parse(String(f.scalar('SELECT token_usage FROM sessions'))).outputTokens,e.usage.outputTokens);
      published.push(e);return{sent:1,failed:0};}}};
    if(!await projectStoredRuntimeMetrics(runtime,event,context,options))await projectStoredRuntimeNotices(runtime,event,context,options);
  });
  return{f,port,runtime,bound,failures,published,compactionUpdates,route,close:async()=>{await bound.close().catch(()=>{});await port.close();f.cleanup();}};
}
test('Native metrics preserve effective model and commit both usage snapshots before publication',async()=>{
  const h=await setup();try{
    await h.route({type:'model_info',model:'actual',modelProvider:'synthetic'});
    assert.equal(h.runtime.turnModelSnapshot?.modelInfo?.effective.id,'actual');assert.equal(h.runtime.turnModelSnapshot?.modelInfo?.rerouted,true);
    await h.route({type:'token_usage',usage:usage(2)});await h.route({type:'token_usage',usage:usage(4)});await h.route({type:'token_usage',usage:usage(4)});
    assert.equal(h.runtime.tokenUsage?.outputTokens,4);
    assert.equal(JSON.parse(String(h.f.scalar('SELECT active_turn_usage FROM sessions'))).outputTokens,4);
    assert.deepEqual(h.failures,[]);
  }finally{await h.close();}
});
test('unknown usage commit does not mutate or publish an unconfirmed in-memory result',async()=>{
  const h=await setup(),execute=h.port.execute.bind(h.port);try{
    h.port.execute=(async(request:any)=>request.command.name==='turn.updateUsage'?{state:'unknown',operationId:request.operationId}:execute(request)) as typeof h.port.execute;
    await assert.rejects(h.route({type:'token_usage',usage:usage(8)}));
    assert.equal(h.runtime.tokenUsage,null);assert.deepEqual(h.published,[]);assert.equal(h.failures.length,1);
  }finally{await h.close();}
});
test('compaction identity is idempotent and invalidates the delivery marker in the Native transaction',async()=>{
  const h=await setup();try{
    h.f.mutate(`UPDATE sessions SET engine_metadata='{"other":"keep","relayHostContext":{"version":1}}'`);
    await h.route({type:'turn_start',turnId:'turn'});
    const compacted={type:'system_notice' as const,noticeType:'context_compaction' as const,title:'compacted',contextCompaction:{threadId:'thread',turnId:'turn'}};
    await h.route(compacted);await h.route(compacted);
    assert.equal(h.f.scalar('SELECT context_compaction_count FROM sessions'),1);
    assert.deepEqual(JSON.parse(String(h.f.scalar('SELECT engine_metadata FROM sessions'))),{other:'keep'});
    assert.equal(h.f.scalar('SELECT count(*) FROM context_compaction_events'),1);
    assert.deepEqual(h.compactionUpdates,[1],'replayed receipt must not publish a second counter refresh');
  }finally{await h.close();}
});

test('compaction start preserves delivery marker and historical events do not replay live side effects',async()=>{
  const h=await setup();try{
    h.f.mutate(`UPDATE sessions SET engine_metadata='{"other":"keep","relayHostContext":{"version":1}}'`);
    await h.route({type:'turn_start',turnId:'turn'});
    const start={type:'item_start' as const,item:{id:'compaction',type:'contextCompaction',status:'in_progress' as const}};
    const complete={type:'item_complete' as const,item:{id:'compaction',type:'contextCompaction',status:'completed' as const}};
    await h.route(start,'recovery');await h.route(complete,'recovery');
    assert.equal(h.runtime.turnItems.length,0);assert.equal(h.published.length,0);
    assert.equal(h.f.scalar('SELECT context_compaction_count FROM sessions'),0);
    assert.deepEqual(h.compactionUpdates,[],'historical compaction must not refresh live session state');
    await h.route(start);
    assert.equal(h.runtime.turnItems[0]?.status,'in_progress');
    assert.deepEqual(JSON.parse(String(h.f.scalar('SELECT engine_metadata FROM sessions'))),{other:'keep',relayHostContext:{version:1}});
    assert.equal(h.f.scalar('SELECT context_compaction_count FROM sessions'),0);
    assert.deepEqual(h.compactionUpdates,[],'starting compaction must not refresh the completed counter');
    await h.route(complete,'request_response');
    assert.equal(h.runtime.turnItems[0]?.status,'completed');
    assert.equal(h.f.scalar('SELECT context_compaction_count FROM sessions'),1);
    assert.deepEqual(h.compactionUpdates,[1]);
    assert.deepEqual(JSON.parse(String(h.f.scalar('SELECT engine_metadata FROM sessions'))),{other:'keep'});
    assert.deepEqual(h.failures,[]);
  }finally{await h.close();}
});

test('unconfirmed compaction write cannot publish a counter refresh or completed process item',async()=>{
  const h=await setup(),execute=h.port.execute.bind(h.port);
  try{
    await h.route({type:'turn_start',turnId:'turn'});
    h.port.execute=(async(request:any)=>request.command.name==='turn.recordCompaction'
      ?{state:'unknown',operationId:request.operationId}:execute(request)) as typeof h.port.execute;
    await assert.rejects(h.route({type:'system_notice',noticeType:'context_compaction',title:'compacted',contextCompaction:{threadId:'thread',turnId:'turn'}}));
    assert.equal(h.f.scalar('SELECT context_compaction_count FROM sessions'),0);
    assert.deepEqual(h.compactionUpdates,[]);assert.deepEqual(h.published,[]);
    assert.equal(h.failures.length,1);
  }finally{await h.close();}
});

test('compaction confirmed by receipt lookup still refreshes once',async()=>{
  const h=await setup(),execute=h.port.execute.bind(h.port);
  try{
    await h.route({type:'turn_start',turnId:'turn'});
    h.port.execute=(async(request:any)=>{
      const result=await execute(request);
      return request.command.name==='turn.recordCompaction'?{state:'unknown',operationId:request.operationId}:result;
    }) as typeof h.port.execute;
    const event={type:'system_notice' as const,noticeType:'context_compaction' as const,title:'compacted',contextCompaction:{threadId:'thread',turnId:'turn'}};
    await h.route(event);await h.route(event);
    assert.deepEqual(h.compactionUpdates,[1]);assert.deepEqual(h.failures,[]);
    assert.equal(h.f.scalar('SELECT context_compaction_count FROM sessions'),1);
  }finally{await h.close();}
});
