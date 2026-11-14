import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,markRead } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { EngineRegistry } from '../engine/registry.js';
import type { EngineAdapter,EngineConnectionOptions,EngineEvent } from '../engine/adapter.js';
import { StoredRuntimeGraph } from './stored-runtime-graph.js';
import { createStoredRuntimePreparation } from './stored-runtime-preparation.js';

async function until(check:()=>boolean){for(let n=0;n<400&&!check();n++)await new Promise(r=>setTimeout(r,5));assert.ok(check(),'resilience stage timed out');}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function setup(resume=true){
  const f=fixture(),sessionId=randomUUID(),attemptId=randomUUID();f.mutate('DELETE FROM engine_resource_leases');
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true,defaultConcurrency:{'codex:default':1}});
  const raw:EngineConnectionOptions[]=[],diagnostics:any[]=[];let sends=0,closes=0,sequence=0,done=false,recoveryGate:Promise<void>|undefined;
  const emit=(options:EngineConnectionOptions,payload:EngineEvent,source:'realtime'|'recovery'='realtime')=>options.onEvent({engineId:'codex',payload,
    meta:{source,sequence:++sequence,observedAt:Date.now(),externalSessionId:'external',externalTurnId:'turn'}});
  const registry=new EngineRegistry([{id:'codex',availability:{getCurrent:()=>({available:true,code:'AVAILABLE'})},recovery:{restartMode:resume?'resume':'interrupt'},runtime:{connect:(options:EngineConnectionOptions)=>{
    raw.push(options);const ready=Promise.resolve().then(async()=>{await options.onSessionReady('external');
      if(options.recoverTurnId){await recoveryGate;emit(options,{type:'recovery_snapshot',turnId:'turn',status:done?'completed':'inProgress',content:done?'original answer':'',items:[],waitingOnInteraction:false},'recovery');}});
    void ready.catch(()=>{});
    return{send:()=>{sends++;void ready.then(()=>emit(options,{type:'turn_start',turnId:'turn'})).catch(()=>{});},cancel:async()=>assert.fail('must not cancel'),respondToInteraction:()=>{},close:()=>{closes++;options.onClosed();}};
  }}} as unknown as EngineAdapter]);
  const graph=new StoredRuntimeGraph({port,storeId:'store',generation:1,registry,assertExclusiveWriter:async()=>{},collectFileChanges:async()=>({}),attachmentAvailability:()=>false,
    resolveResource:()=>({label:'Synthetic',defaultMaxActiveTurns:1}),diagnostic:(...args)=>diagnostics.push(args),
    prepareRuntime:createStoredRuntimePreparation(async()=>({displayNames:{},modelDefaults:{},defaultModelId:null}))});
  const queued=await port.execute({...markRead(),operationId:'resilience-enqueue',command:{name:'turn.enqueue',input:{sessionId,attemptId,messageId:randomUUID(),engineId:'codex',resourceKey:'codex:default',content:'original input',metadata:null,expectedPreferencesRevision:0,origin:{kind:'direct'},draft:{projectId:'project',title:'Resilience',titleManuallySet:false}}}});
  try{
    assert.equal(queued.state,'committed');await graph.scheduler.drain('codex:default');
    await until(()=>!!graph.runtimes.get(sessionId)?.currentTurnId);await graph.connections.getBinding(sessionId)!.events.storage.drain();
  }catch(error){await graph.suspend();await port.close();f.cleanup();throw error;}
  return{f,port,graph,sessionId,attemptId,raw,diagnostics,sends:()=>sends,closes:()=>closes,
    delayRecovery:(gate:Promise<void>)=>{recoveryGate=gate;},providerDone:()=>{done=true;},emit:(payload:EngineEvent)=>emit(raw[0]!,payload),finish:()=>{done=true;emit(raw[0]!,{type:'message_complete',turnId:'turn',content:'original answer'});},
    cleanup:async()=>{try{await graph.suspend();}finally{await port.close();f.cleanup();}}};
}

test('slow stream and terminal socket publication cannot block the final transaction or lease release',async()=>{
  const h=await setup();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let stream=0,terminal=0;
  h.graph.hub.broadcastSession=async()=>{stream++;await gate;return{sent:1,failed:0};};
  h.graph.hub.broadcastTerminal=async()=>{terminal++;await gate;return{sent:1,failed:0};};
  try{
    for(let n=0;n<2000;n++)h.emit({type:'delta',itemId:'text',phase:'commentary',content:'米'});
    h.finish();await until(()=>h.f.scalar(`SELECT status FROM sessions WHERE id='${h.sessionId}'`)==='completed');
    await until(()=>!h.graph.runtimes.get(h.sessionId)?.isRunning);
    assert.ok(stream>0);assert.equal(terminal,1);assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
    assert.equal(h.f.scalar(`SELECT content FROM messages WHERE session_id='${h.sessionId}' AND role='assistant'`),'original answer');
    assert.deepEqual(h.diagnostics,[]);
  }finally{release();await h.cleanup();}
});

test('a failed queue also recovers on actual transport closure without a later terminal notification',async()=>{
  const h=await setup(),execute=h.port.execute.bind(h.port);let injected=false;
  h.port.execute=(async request=>{if(request.command.name==='turn.updateUsage'&&!injected){injected=true;return{state:'rejected',code:'STORAGE_UNAVAILABLE'};}return execute(request);}) as typeof h.port.execute;
  try{
    h.emit({type:'token_usage',usage:{inputTokens:10,cachedInputTokens:0,outputTokens:2,reasoningOutputTokens:0,totalTokens:12,modelContextWindow:100}});
    await until(()=>h.graph.connections.getBinding(h.sessionId)!.events.storage.health().failed);
    h.providerDone();h.raw[0]!.onClosed();
    await until(()=>h.f.scalar(`SELECT status FROM sessions WHERE id='${h.sessionId}'`)==='completed');
    assert.equal(h.sends(),1);assert.equal(h.raw.length,2);assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
  }finally{await h.cleanup();}
});

test('recovering connections refuse new control effects and shutdown waits for the recovery read fence',async()=>{
  const h=await setup(),execute=h.port.execute.bind(h.port),entered=deferred(),release=deferred();
  const read=h.port.readRuntimeRecoveryTurn.bind(h.port);
  h.port.readRuntimeRecoveryTurn=async input=>{entered.resolve();await release.promise;return read(input);};
  let injected=false;h.port.execute=(async request=>{if(request.command.name==='turn.finishFromFact'&&!injected){injected=true;return{state:'rejected',code:'STORAGE_UNAVAILABLE'};}return execute(request);}) as typeof h.port.execute;
  let suspended:Promise<void>|undefined;
  try{
    const original=h.graph.runtimes.get(h.sessionId)!.engineConnection!;
    h.finish();await entered.promise;
    await assert.rejects(Promise.resolve().then(()=>original.cancel()),{code:'CONFLICT'});
    let ended=false;suspended=h.graph.suspend().then(()=>{ended=true;});await new Promise(r=>setImmediate(r));
    assert.equal(ended,false);release.resolve();await suspended;
    assert.equal(h.raw.length,1);assert.equal(h.sends(),1);assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
  }finally{release.resolve();await suspended?.catch(()=>{});await h.cleanup();}
});

test('a slow session refresh cannot hold the next queued task after terminal commit',async()=>{
  const h=await setup(),release=deferred(),second=randomUUID();
  const publish=h.graph.hub.broadcastSessionState.bind(h.graph.hub);h.graph.hub.broadcastSessionState=async(...args)=>{await release.promise;return publish(...args);};
  try{
    const queued=await h.port.execute({...markRead(),operationId:'next-queued',command:{name:'turn.enqueue',input:{sessionId:second,attemptId:randomUUID(),messageId:randomUUID(),engineId:'codex',resourceKey:'codex:default',content:'next input',metadata:null,expectedPreferencesRevision:0,origin:{kind:'direct'},draft:{projectId:'project',title:'Next',titleManuallySet:false}}}});
    assert.equal(queued.state,'committed');await h.graph.scheduler.drain('codex:default');assert.equal(h.sends(),1);
    h.finish();await until(()=>h.sends()===2);assert.equal(h.f.scalar(`SELECT status FROM sessions WHERE id='${h.sessionId}'`),'completed');
  }finally{release.resolve();await h.cleanup();}
});

test('shutdown also drains a recovery that already replaced its old physical record',async()=>{
  const h=await setup(),release=deferred(),execute=h.port.execute.bind(h.port),restore=h.graph.connections.restore.bind(h.graph.connections);
  let active=false,injected=false;
  h.graph.connections.restore=async(...args)=>{active=true;try{return await restore(...args);}finally{active=false;}};
  h.delayRecovery(release.promise);
  h.port.execute=(async request=>{if(request.command.name==='turn.finishFromFact'&&!injected){injected=true;return{state:'rejected',code:'STORAGE_UNAVAILABLE'};}return execute(request);}) as typeof h.port.execute;
  try{
    h.finish();await until(()=>h.raw.length===2);assert.equal(active,true);
    await h.graph.suspend();assert.equal(active,false,'no provider snapshot wait may outlive suspension');
    assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);assert.equal(h.sends(),1);
  }finally{release.resolve();await h.cleanup();}
});

test('committed publications remain valid when a newer runtime replaces the original attempt',async()=>{
  const h=await setup(),release=deferred(),entered=deferred();const guards:Array<()=>boolean>=[];
  h.graph.hub.broadcastTerminal=async(_result,options)=>{guards.push(options.isCurrent);entered.resolve();await release.promise;return{sent:1,failed:0};};
  try{
    h.finish();await entered.promise;await until(()=>!h.graph.runtimes.get(h.sessionId)!.isRunning);
    const next=await h.port.execute({...markRead(),operationId:'same-session-next',command:{name:'turn.enqueue',input:{sessionId:h.sessionId,attemptId:randomUUID(),messageId:randomUUID(),engineId:'codex',resourceKey:'codex:default',content:'next input',metadata:null,expectedPreferencesRevision:0,origin:{kind:'direct'}}}});
    assert.equal(next.state,'committed');await h.graph.scheduler.drain('codex:default');await until(()=>h.sends()===2);
    assert.equal(guards[0]!(),true,'a committed reply must not disappear when another turn starts');
  }finally{release.resolve();await h.cleanup();}
});

for(const failure of ['usage','terminal','persistent'] as const)test(`failed ${failure} queue recovers once from provider evidence without replaying input`,async()=>{
  const h=await setup(),execute=h.port.execute.bind(h.port);let injected=false;
  h.port.execute=(async request=>{
    if((failure==='usage'?request.command.name==='turn.updateUsage':request.command.name==='turn.finishFromFact')&&(!injected||failure==='persistent')){
      injected=true;return{state:'rejected',code:'STORAGE_UNAVAILABLE'};
    }return execute(request);
  }) as typeof h.port.execute;
  try{
    if(failure==='usage'){
      h.emit({type:'token_usage',usage:{inputTokens:10,cachedInputTokens:0,outputTokens:2,reasoningOutputTokens:0,totalTokens:12,modelContextWindow:100}});
      await until(()=>h.graph.connections.getBinding(h.sessionId)!.events.storage.health().failed);
      assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
    }
    h.finish();h.finish();await until(()=>h.raw.length===2);
    if(failure==='persistent'){
      await until(()=>!!h.graph.connections.getBinding(h.sessionId)?.events.storage.health().failed);
      await new Promise(r=>setImmediate(r));assert.equal(h.raw.length,2);
      assert.equal(h.f.scalar(`SELECT count(*) FROM messages WHERE session_id='${h.sessionId}' AND role='assistant'`),0);
      assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
    }else{
      await until(()=>h.f.scalar(`SELECT status FROM sessions WHERE id='${h.sessionId}'`)==='completed');
      assert.equal(h.f.scalar(`SELECT count(*) FROM messages WHERE session_id='${h.sessionId}' AND role='assistant'`),1);
      assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
      h.finish();await new Promise(r=>setImmediate(r));assert.equal(h.raw.length,2,'late callbacks must not start another recovery');
    }
    assert.equal(h.sends(),1);assert.equal(h.closes(),1);
    assert.equal(h.diagnostics[0][1].attemptId,h.attemptId);assert.equal(h.diagnostics[0][1].code,'STORAGE_UNAVAILABLE');
  }catch(error){throw new Error(`${String(error)} diagnostics=${JSON.stringify(h.diagnostics)}`);}finally{await h.cleanup().catch(()=>{});}
});

test('nonresumable adapters retain the failed attempt instead of reconnecting or claiming success',async()=>{
  const h=await setup(false),execute=h.port.execute.bind(h.port);
  h.port.execute=(async request=>request.command.name==='turn.finishFromFact'?{state:'rejected',code:'STORAGE_UNAVAILABLE'}:execute(request)) as typeof h.port.execute;
  try{h.finish();await until(()=>h.graph.connections.getBinding(h.sessionId)!.events.storage.health().failed);
    assert.equal(h.raw.length,1);assert.equal(h.sends(),1);assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
  }finally{await h.cleanup();}
});
