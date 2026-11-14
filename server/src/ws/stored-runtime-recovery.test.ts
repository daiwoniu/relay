import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,markRead } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StoredRuntimeGraph } from './stored-runtime-graph.js';
import { EngineRegistry } from '../engine/registry.js';
import type { EngineAdapter,EngineConnectionOptions,EngineEvent } from '../engine/adapter.js';
import { buildEngineTurnFact } from '../engine/turn-fact-builder.js';
const until=async(check:()=>boolean)=>{for(let n=0;n<400&&!check();n++)await new Promise(r=>setTimeout(r,5));assert.ok(check(),'recovery stage timed out');};

for(const mode of ['running','suspended','completed','lost-terminal-projection','interrupt','stopping','stopping-completed'] as const)test(`Native cold recovery ${mode} never resends the original input`,async()=>{
  const f=fixture(),sessionId=randomUUID(),attemptId=randomUUID();
  f.mutate('DELETE FROM engine_resource_leases;DELETE FROM messages;DELETE FROM sessions');
  let port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true,defaultConcurrency:{'codex:default':1}});
  let graph:StoredRuntimeGraph|undefined,connections=0,sends=0,cancels=0,options:EngineConnectionOptions|undefined,sequence=0;
  const diagnostics:string[]=[];
  const emit=(payload:EngineEvent,source:'recovery'|'realtime')=>options!.onEvent({engineId:'codex',payload,meta:{source,sequence:++sequence,observedAt:Date.now(),externalSessionId:'external',externalTurnId:'turn'}});
  try{
    const enqueued=await port.execute({...markRead(),operationId:'enqueue',command:{name:'turn.enqueue',input:{sessionId,attemptId,messageId:randomUUID(),engineId:'codex',resourceKey:'codex:default',content:'original input must not resend',metadata:null,expectedPreferencesRevision:0,origin:{kind:'direct'},draft:{projectId:'project',title:'Recovery',titleManuallySet:false}}}});assert.equal(enqueued.state,'committed');
    const claimed=await port.execute({...markRead(),operationId:'claim',principal:{kind:'system',purpose:'scheduler'},command:{name:'queue.claim',input:{resourceKey:'codex:default',claimToken:'claim'}}});
    assert.equal(claimed.state,'committed');if(claimed.state!=='committed'||!claimed.value)throw Error('claim missing');
    const principal={kind:'runtime',sessionId,attemptId,connectionId:'old-connection',runtimeVersion:1} as const;
    await port.registerRuntime({storeId:'store',workerGeneration:1,leaseToken:claimed.value.leaseToken,runtime:principal});
    const bound=await port.execute({...markRead(),principal,operationId:'bind',command:{name:'turn.bindExternalSession',input:{sessionId,engineId:'codex',expectedExternalSessionId:null,externalSessionId:'external'}}});assert.equal(bound.state,'committed');
    async function fact(payload:EngineEvent,n:number){const value=buildEngineTurnFact({engineId:'codex',payload,meta:{source:'realtime',sequence:n,observedAt:Date.now()-1000,externalSessionId:'external',externalTurnId:'turn'}},{sessionId,attemptId,connectionId:'old-connection',engineId:'codex',userStopRequested:false})!;
      const stored=await port.execute({...markRead(),principal,operationId:'fact-'+n,command:{name:'turn.appendFact',input:{fact:value}}});assert.equal(stored.state,'committed');return value;}
    const started=await fact({type:'turn_start',turnId:'turn'},1);
    const projected=await port.execute({...markRead(),principal,operationId:'started',command:{name:'turn.projectStarted',input:{sessionId,factId:started.id,externalTurnId:'turn'}}});assert.equal(projected.state,'committed');
    if(mode==='lost-terminal-projection'){
      const question=await port.execute({...markRead(),principal,operationId:'durable-question',command:{name:'turn.recordAsyncQuestion',input:{sessionId,turnId:'turn',item:{id:'async-question:recover-question',type:'interaction',status:'in_progress',details:{interactionKind:'async_question',title:'Durable question',questions:[{title:'Durable question'}]}}}}});assert.equal(question.state,'committed');
      await fact({type:'message_complete',turnId:'turn',content:'recovered answer'},2);
    }
    if(mode==='stopping'||mode==='stopping-completed'){
      const stop=await port.execute({...markRead(),operationId:'stop-before-restart',command:{name:'turn.requestStop',input:{sessionId,expectedAttemptId:attemptId}}});assert.equal(stop.state,'committed');
    }
    await port.close();port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:2,defaultConcurrency:{'codex:default':1}});
    const execute=port.execute.bind(port);port.execute=(async request=>{const result=await execute(request);if(result.state==='rejected')throw Error(`${request.command.name}: ${result.code}`);return result;}) as typeof port.execute;
    const registry=new EngineRegistry([{id:'codex',availability:{getCurrent:()=>({available:true})},recovery:{restartMode:mode==='interrupt'?'interrupt':'resume'},runtime:{connect:(input:EngineConnectionOptions)=>{
      connections++;options=input;
      assert.equal(input.recoverTurnId,'turn');assert.equal(input.externalSessionId,'external');
      void Promise.resolve().then(async()=>{await input.onSessionReady('external');emit({type:'recovery_snapshot',turnId:'turn',status:mode==='running'||mode==='suspended'||mode==='stopping'?'inProgress':'completed',content:mode==='running'||mode==='suspended'||mode==='stopping'?'':'recovered answer',items:[],waitingOnInteraction:false},'recovery');});
      return{send:()=>{sends++;throw Error('recovery sent input');},cancel:async()=>{cancels++;emit({type:'error',diagnostic:{code:'CODEX_TURN_INTERRUPTED',phase:'send',retryable:false,userMessage:'synthetic interruption'}},'realtime');},respondToInteraction:()=>{},close:()=>input.onClosed()};
    }}} as unknown as EngineAdapter]);
    graph=new StoredRuntimeGraph({port,storeId:'store',generation:2,registry,assertExclusiveWriter:async()=>{},collectFileChanges:async()=>({}),attachmentAvailability:()=>false,resolveResource:()=>({label:'Synthetic',defaultMaxActiveTurns:1}),diagnostic:code=>diagnostics.push(code)});
    const result=await graph.restoreStartup();assert.equal(result.restored,1);assert.equal(sends,0);
    if(mode==='running'||mode==='suspended'){
      assert.equal(f.scalar(`SELECT status FROM sessions WHERE id='${sessionId}'`),'processing');
      assert.equal(graph.runtimes.get(sessionId)!.isRecovering,false);assert.equal(f.scalar(`SELECT count(*) FROM engine_resource_leases WHERE session_id='${sessionId}'`),1);
      if(mode==='suspended'){
        const previous=options!;await graph.suspend();
        assert.equal(f.scalar(`SELECT status FROM sessions WHERE id='${sessionId}'`),'processing');
        assert.equal(f.scalar(`SELECT count(*) FROM engine_resource_leases WHERE session_id='${sessionId}'`),1);
        assert.equal(f.scalar(`SELECT count(*) FROM messages WHERE session_id='${sessionId}' AND role='assistant'`),0);
        previous.onEvent({engineId:'codex',payload:{type:'message_complete',turnId:'turn',content:'discard late shutdown callback'},meta:{source:'realtime',sequence:++sequence,observedAt:Date.now(),externalSessionId:'external',externalTurnId:'turn'}});
        await port.close();port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:3,defaultConcurrency:{'codex:default':1}});
        graph=new StoredRuntimeGraph({port,storeId:'store',generation:3,registry,assertExclusiveWriter:async()=>{},collectFileChanges:async()=>({}),attachmentAvailability:()=>false,resolveResource:()=>({label:'Synthetic',defaultMaxActiveTurns:1}),diagnostic:code=>diagnostics.push(code)});
        assert.equal((await graph.restoreStartup()).restored,1);
      }
      emit({type:'message_complete',turnId:'turn',content:'recovered answer'},'realtime');await until(()=>!graph!.runtimes.get(sessionId)!.isRunning);
    }
    assert.equal(connections,mode==='interrupt'?0:mode==='suspended'?2:1);
    assert.equal(f.scalar(`SELECT status FROM sessions WHERE id='${sessionId}'`),mode==='interrupt'?'interrupted':mode==='stopping'?'stopped':'completed');
    assert.equal(cancels,mode==='stopping'?1:0);
    assert.equal(f.scalar(`SELECT count(*) FROM messages WHERE session_id='${sessionId}' AND role='assistant'`),1);
    if(mode==='stopping-completed')assert.equal(f.scalar(`SELECT content FROM messages WHERE session_id='${sessionId}' AND role='assistant'`),'recovered answer');
    if(mode==='lost-terminal-projection')assert.equal(f.scalar(`SELECT json_extract(items,'$[0].id') FROM messages WHERE session_id='${sessionId}' AND role='assistant'`),'async-question:recover-question');
    assert.equal(f.scalar(`SELECT count(*) FROM engine_resource_leases WHERE session_id='${sessionId}'`),0);
    assert.deepEqual(diagnostics,[]);
  }finally{try{await graph?.close();}catch{/* Preserve assertions while always closing the worker. */}await port.close();f.cleanup();}
});
