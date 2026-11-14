import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { CodeBuddyAdapter } from '../codebuddy/adapter.js';
import { OpenCodeAdapter } from '../opencode/adapter.js';
import { ZcodeAdapter } from '../zcode/adapter.js';
import { createCodexConnection } from '../codex/client.js';
import { connectWithHostContext } from './host-context.js';
import { observeSessionReady } from './runtime-performance.js';
import type { SessionRuntime } from './runtime.js';
import type { EngineConnection,EngineConnectionOptions } from './adapter.js';
import type { JsonRpcEnvelope } from './transports/transport.js';
import { fixture,markRead } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StoredRuntimeEvents } from './stored-runtime-events.js';
import { createSessionRuntimeState,prepareClaimedSessionRuntime } from './runtime.js';
import { finishStoredAssistant } from '../ws/stored-assistant-terminal.js';
import { EngineRegistry } from './registry.js';
import { StoredRuntimeConnections } from '../ws/stored-runtime-connections.js';
import { StoredQueuedTurnDispatcher } from '../ws/stored-queued-turn-dispatch.js';
import { StoredProviderTurnScheduler } from './concurrency/stored-scheduler.js';

const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};};
const tick=()=>new Promise<void>(r=>setImmediate(r));
async function until(check:()=>boolean){for(let i=0;i<100&&!check();i++)await new Promise<void>(r=>setTimeout(r,5));assert.ok(check(),'mock stage timed out');}
class Transport {
  state:'open'|'closed'='open';sent:JsonRpcEnvelope[]=[];private sequence=0;
  holdPrompt=false;
  rejectStop=false;
  private messages=new Set<(message:JsonRpcEnvelope)=>void>();private closes=new Set<()=>void>();
  nextRequestId(){return++this.sequence;}
  send(message:JsonRpcEnvelope){this.sent.push(message);if(!message.method||message.id===undefined)return;
    if(this.holdPrompt&&(message.method==='session/prompt'||message.method==='session/send'))return;
    if(this.rejectStop&&message.method==='session/stop'){queueMicrotask(()=>this.emitMessage({id:message.id,error:{code:-32000,message:'private synthetic stop failure'}}));return;}
    const result=message.method==='initialize'?{protocolVersion:1,agentCapabilities:{}}:message.method==='session/new'||message.method==='session/load'?{sessionId:'external'}
      :message.method==='session/create'||message.method==='session/resume'?{session:{sessionId:'external'},settings:{model:{available:[]}}}
      :message.method==='session/prompt'?{stopReason:'cancelled'}:{};
    queueMicrotask(()=>{for(const listener of this.messages)listener({id:message.id,result});});
  }
  onOpen(_listener:()=>void){return()=>{};}onError(_listener:(error:Error)=>void){return()=>{};}
  onMessage(listener:(message:JsonRpcEnvelope)=>void){this.messages.add(listener);return()=>this.messages.delete(listener);}
  emitMessage(message:JsonRpcEnvelope){for(const listener of this.messages)listener(message);}
  onClose(listener:()=>void){this.closes.add(listener);return()=>this.closes.delete(listener);}
  close(){if(this.state==='closed')return;this.state='closed';for(const listener of this.closes)listener();}
  terminate(){this.close();}async closeAndWait(){this.close();}diagnostic(){return'';}
}
function adapterFor(kind:'codebuddy'|'opencode'|'zcode',transport:Transport,cancelConfirmationTimeoutMs?:number){
  const manager={getOrCreate:()=>transport,acquire:()=>transport,release:async()=>{},setBusy:()=>true,touch:()=>true};
  const settings={getAvailability:()=>({available:true,code:'AVAILABLE'}),manager:manager as never,...(cancelConfirmationTimeoutMs?{cancelConfirmationTimeoutMs}:{})};
  return kind==='codebuddy'?new CodeBuddyAdapter(settings):kind==='opencode'?new OpenCodeAdapter(settings):new ZcodeAdapter(settings);
}
function acp(kind:'codebuddy'|'opencode'|'zcode',ready:()=>unknown,onEvent?:EngineConnectionOptions['onEvent'],onClosed?:()=>void,cancelTimeout?:number){
  const transport=new Transport(),errors:string[]=[],adapter=adapterFor(kind,transport,cancelTimeout);
  const options:EngineConnectionOptions={sessionId:'mock-session',cwd:'D:/synthetic',externalSessionId:null,onSessionReady:observeSessionReady({} as SessionRuntime,ready),
    onEvent:event=>{if(event.payload.type==='error')errors.push(event.payload.diagnostic.userMessage);onEvent?.(event);},onClosed:()=>{onClosed?.();},hostContext:{delivered:true,onDelivered:()=>{}}};
  const connection=connectWithHostContext(input=>adapter.runtime.connect(input),options);
  return{connection,transport,errors,sends:()=>transport.sent.filter(message=>message.method===(kind==='zcode'?'session/send':'session/prompt')).length};
}

for(const kind of ['codebuddy','opencode','zcode'] as const){
  test(`${kind} failed or timed-out cancellation cannot resolve as a confirmed interruption`,async()=>{
    const h=acp(kind,()=>{},undefined,undefined,10),keepAlive=setInterval(()=>{},1000);h.transport.holdPrompt=true;h.transport.rejectStop=true;
    try{h.connection.send('synthetic input');await until(()=>h.sends()===1);await assert.rejects(h.connection.cancel(),/CANCEL_UNCONFIRMED/);}
    finally{clearInterval(keepAlive);h.connection.close();}
  });
  test(`${kind} actual adapter and Native scheduler complete two turns without closing the shared connection`,async()=>{
    const f=fixture();f.mutate('DELETE FROM engine_resource_leases');const key=`${kind}:default`;
    const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true,defaultConcurrency:{[key]:1}});
    const transport=new Transport(),runtimes=new Map<string,SessionRuntime>(),failures:string[]=[];let completed=0;
    const pool=new StoredRuntimeConnections({port,storeId:'store',generation:1,runtimes,registry:new EngineRegistry([adapterFor(kind,transport)]),
      prepareRuntime:async(claim,payload)=>{const runtime=createSessionRuntimeState({sessionId:claim.sessionId,projectId:payload.session.projectId,engine:claim.engineId});
        prepareClaimedSessionRuntime(runtime,{projectId:payload.session.projectId,attemptId:claim.attemptId,resourceKey:claim.resourceKey,leaseToken:claim.leaseToken,
          requestedByUserId:claim.requestedByUserId,claimedAt:payload.claimedAt,preferences:{modelId:null,reasoningEffort:null,serviceTier:null}});return runtime;},
      hostContext:()=>({delivered:true,onDelivered:()=>{}}),onFailure:(_runtime,code)=>{failures.push(code);},
      onEvent:async(runtime,event,context)=>{
        if(event.payload.type==='message_complete')await finishStoredAssistant(runtime,event.payload,context,{messageId:`result-${runtime.attemptId}`,now:Date.now(),fileChanges:{}});
        if(event.payload.type==='error')await context.finishTerminal({id:`failure-${runtime.attemptId}`,turnId:runtime.currentTurnId||runtime.attemptId!,content:'',items:null,metadata:null,durationMs:null});
      },onClosed:async(runtime,context)=>{await context.finishTerminal({id:`closed-${runtime.attemptId}`,turnId:runtime.currentTurnId||runtime.attemptId!,content:'',items:null,metadata:null,durationMs:null});},
      onTerminalCommitted:()=>{completed++;},
    });
    const dispatcher=new StoredQueuedTurnDispatcher(port,{prepare:(...args)=>pool.prepare(...args)});
    const scheduler=new StoredProviderTurnScheduler(port,{storeId:'store',generation:1,assertExclusiveWriter:async()=>{},onFailure:()=>{failures.push('scheduler');},
      start:(claim,context)=>dispatcher.start(claim,context),failed:async()=>{failures.push('dispatch');}});
    try{for(let n=1;n<=2;n++){
      const result=await port.execute({...markRead(),operationId:`enqueue-${n}`,command:{name:'turn.enqueue',input:{sessionId:'pooled',attemptId:`attempt-${n}`,messageId:`user-${n}`,
        engineId:kind,resourceKey:key,content:`input-${n}`,metadata:null,expectedPreferencesRevision:0,origin:{kind:'direct'},...(n===1?{draft:{projectId:'project',title:'test',titleManuallySet:false}}:{})}}});
      assert.equal(result.state,'committed');await scheduler.drain(key);
      if(kind==='zcode'){await until(()=>runtimes.get('pooled')?.currentTurnId!=null);transport.emitMessage({method:'session/event',params:{sessionId:'external',type:'turn.completed',payload:{response:`result-${n}`}}});}
      await until(()=>completed===n||failures.length>0);assert.equal(completed,n);assert.deepEqual(failures,[]);assert.equal(transport.state,'open');
    }
      const starts=transport.sent.filter(message=>message.method==='session/new'||message.method==='session/create');assert.equal(starts.length,1);
      assert.equal(transport.sent.filter(message=>message.method===(kind==='zcode'?'session/send':'session/prompt')).length,2);
      assert.equal(f.scalar("SELECT engine_session_id FROM sessions WHERE id='pooled'"),'external');await pool.closeSession('pooled');
    }finally{await scheduler.close();transport.close();await port.close();f.cleanup();}
  });
  test(`${kind} physical transport close commits its failure before connection identity is retired`,async()=>{
    const f=fixture();f.mutate(`UPDATE sessions SET engine='${kind}',engine_session_id=NULL,status='pending';UPDATE engine_resource_leases SET engine_id='${kind}',state='claimed',started_at=NULL`);
    const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
    const runtime=createSessionRuntimeState({sessionId:'session',projectId:'project',engine:kind});
    runtime.attemptId='attempt';runtime.engineConnectionId='connection';runtime.leaseToken='lease';let published=0,failed=false;
    const bound=new StoredRuntimeEvents(runtime,port,{storeId:'store',generation:1,runtimeVersion:1,isOwned:()=>true,onFailure:()=>{failed=true;},onTerminalCommitted:()=>{published++;}});
    const h=acp(kind,()=>bound.sessionReady(null)('external'),event=>bound.accept(event,()=>{}),()=>{
      void bound.connectionClosed(async context=>{await context.finishTerminal({id:`closed-${kind}`,turnId:runtime.currentTurnId!,content:'',items:null,metadata:null,durationMs:null});}).catch(()=>{failed=true;});
    });h.transport.holdPrompt=true;
    try{h.connection.send('synthetic input');await until(()=>runtime.currentTurnId!==null);h.transport.close();await until(()=>published===1||failed);
      assert.equal(failed,false);assert.equal(published,1);assert.equal(f.scalar('SELECT status FROM sessions'),'failed');
      assert.equal(f.scalar('SELECT count(*) FROM engine_resource_leases'),0);assert.equal(runtime.engineConnectionId,'connection');
      assert.equal(bound.storage.isTerminalCommitted(),true);
    }finally{h.connection.close();await bound.close().catch(()=>{});await port.close();f.cleanup();}
  });
  test(`${kind} actual adapter events reach Native start and terminal transactions in order`,async()=>{
    const f=fixture();f.mutate(`UPDATE sessions SET engine='${kind}',engine_session_id=NULL,status='pending';UPDATE engine_resource_leases SET engine_id='${kind}',state='claimed',started_at=NULL`);
    const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
    const runtime=createSessionRuntimeState({sessionId:'session',projectId:'project',engine:kind});
    runtime.attemptId='attempt';runtime.engineConnectionId='connection';runtime.leaseToken='lease';
    let published=0,failed=false;
    const bound=new StoredRuntimeEvents(runtime,port,{storeId:'store',generation:1,runtimeVersion:1,isOwned:()=>true,onFailure:()=>{failed=true;},
      onTerminalCommitted:()=>{assert.equal(f.scalar('SELECT count(*) FROM engine_resource_leases'),0);published++;}});
    const h=acp(kind,()=>bound.sessionReady(null)('external'),event=>bound.accept(event,async(captured,context)=>{
      if(captured.payload.type!=='message_complete'&&captured.payload.type!=='error')return;
      assert.ok(runtime.currentTurnId);assert.equal(f.scalar('SELECT state FROM engine_resource_leases'),'running');
      if(captured.payload.type==='message_complete')await finishStoredAssistant(runtime,captured.payload,context,{messageId:`terminal-${kind}`,now:Date.now(),fileChanges:{}});
      else await context.finishTerminal({id:`terminal-${kind}`,turnId:runtime.currentTurnId!,content:'',items:null,metadata:null,durationMs:null});
    }));
    try{h.connection.send('synthetic input');
      if(kind==='zcode'){await until(()=>h.sends()===1);h.transport.emitMessage({method:'session/event',params:{sessionId:'external',type:'turn.completed',payload:{response:'synthetic result'}}});}
      await until(()=>published===1||failed);assert.equal(failed,false);assert.equal(published,1);
      assert.equal(f.scalar("SELECT count(*) FROM _relay_storage_operations WHERE command_name='turn.projectStarted'"),1);
      assert.equal(f.scalar("SELECT count(*) FROM _relay_storage_operations WHERE command_name='turn.finishFromFact'"),1);
      assert.equal(f.scalar('SELECT count(*) FROM engine_terminal_decisions'),1);assert.equal(h.sends(),1);
    }finally{h.connection.close();await bound.close().catch(()=>{});await port.close();f.cleanup();}
  });
  test(`${kind} actual onSessionReady waits for the Native binding receipt before sending`,async()=>{
    const f=fixture();f.mutate(`UPDATE sessions SET engine='${kind}',engine_session_id=NULL;UPDATE engine_resource_leases SET engine_id='${kind}'`);
    const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
    const runtime=createSessionRuntimeState({sessionId:'session',projectId:'project',engine:kind});
    runtime.attemptId='attempt';runtime.engineConnectionId='connection';runtime.leaseToken='lease';
    const bound=new StoredRuntimeEvents(runtime,port,{storeId:'store',generation:1,runtimeVersion:1,isOwned:()=>true,onFailure:()=>assert.fail('unexpected Native failure')});
    const entered=gate(),release=gate(),execute=port.execute.bind(port);
    port.execute=(async(request:any)=>{if(request.command.name==='turn.bindExternalSession'){entered.resolve();await release.promise;}return execute(request);}) as typeof port.execute;
    const h=acp(kind,()=>bound.sessionReady(null)('external'),event=>bound.accept(event,()=>{}));
    try{
      h.connection.send('synthetic input');await entered.promise;assert.equal(h.sends(),0);assert.equal(f.scalar('SELECT engine_session_id FROM sessions'),null);
      release.resolve();await until(()=>h.sends()===1);assert.equal(f.scalar('SELECT engine_session_id FROM sessions'),'external');
      await until(()=>f.scalar('SELECT active_turn_id FROM sessions')!==null);
      assert.equal(f.scalar('SELECT status FROM sessions'),'processing');
      assert.equal(f.scalar("SELECT count(*) FROM _relay_storage_operations WHERE command_name='turn.bindExternalSession'"),1);
    }finally{release.resolve();h.connection.close();await bound.close().catch(()=>{});await port.close();f.cleanup();}
  });
  test(`${kind} actual send waits for session persistence through the host-context wrapper`,async()=>{
    const entered=gate(),release=gate(),h=acp(kind,async()=>{entered.resolve();await release.promise;});try{
      h.connection.send('synthetic input');await entered.promise;await tick();assert.equal(h.sends(),0);release.resolve();await until(()=>h.sends()===1);
    }finally{release.resolve();h.connection.close();}
  });
  test(`${kind} failed asynchronous persistence prevents a prompt and owns the rejection`,async()=>{
    const h=acp(kind,async()=>{throw Error('private synthetic persistence detail');});try{
      h.connection.send('synthetic input');await until(()=>h.errors.length>0);assert.equal(h.sends(),0);assert.equal(h.errors.some(error=>error.includes('private synthetic')),false);
    }finally{h.connection.close();}
  });
  test(`${kind} close while persistence is pending cannot send after the late success`,async()=>{
    const entered=gate(),release=gate(),h=acp(kind,async()=>{entered.resolve();await release.promise;});try{
      h.connection.send('synthetic input');await entered.promise;h.connection.close();release.resolve();await tick();await tick();assert.equal(h.sends(),0);
    }finally{release.resolve();h.connection.close();}
  });
  test(`${kind} cancellation during persistence prevents the still-unstarted prompt`,async()=>{
    const entered=gate(),release=gate(),h=acp(kind,async()=>{entered.resolve();await release.promise;});try{
      h.connection.send('synthetic input');await entered.promise;const cancelled=h.connection.cancel();release.resolve();await cancelled;assert.equal(h.sends(),0);
    }finally{release.resolve();h.connection.close();}
  });
}

async function codex(ready:()=>unknown){
  const server=new WebSocketServer({port:0});await new Promise<void>(r=>server.once('listening',r));const address=server.address();assert.ok(address&&typeof address==='object');
  const methods:string[]=[],errors:string[]=[];
  server.on('connection',socket=>socket.on('message',raw=>{const message=JSON.parse(raw.toString());methods.push(message.method);if(message.id===undefined)return;
    const result=message.method==='config/read'?{config:{model:'synthetic'}}:message.method==='thread/start'?{thread:{id:'external'}}:message.method==='turn/start'?{turn:{id:'turn'}}:{};
    socket.send(JSON.stringify({id:message.id,result}));
  }));
  const raw=createCodexConnection(event=>{if(event.type==='error')errors.push(event.message);},{wsUrl:`ws://127.0.0.1:${address.port}`,onThreadReady:ready});
  const connection:Pick<EngineConnection,'send'|'cancel'|'close'>={send:raw.send,cancel:raw.interrupt,close:raw.close};
  return{connection,methods,errors,cleanup:async()=>{raw.close();for(const peer of server.clients)peer.terminate();await new Promise<void>(r=>server.close(()=>r()));}};
}

test('Zcode subscription replay before dispatch cannot contaminate the new prompt or final response',async()=>{
  const entered=gate(),release=gate(),events:Parameters<EngineConnectionOptions['onEvent']>[0][]=[];
  const h=acp('zcode',async()=>{entered.resolve();await release.promise;},event=>events.push(event));
  try{h.connection.send('new input');await entered.promise;
    h.transport.emitMessage({method:'session/event',params:{sessionId:'external',type:'model.streaming',payload:{kind:'text_delta',delta:'replayed old text'}}});
    h.transport.emitMessage({method:'session/event',params:{sessionId:'external',type:'turn.completed',payload:{response:'replayed old result'}}});
    assert.equal(events.filter(event=>event.payload.type==='delta'||event.payload.type==='message_complete').length,0);
    release.resolve();await until(()=>h.sends()===1);await tick();await tick();
    h.transport.emitMessage({method:'session/event',params:{sessionId:'external',type:'model.streaming',payload:{kind:'text_delta',delta:'fresh result'}}});
    h.transport.emitMessage({method:'session/event',params:{sessionId:'external',type:'turn.completed',payload:{response:''}}});
    const completed=events.filter(event=>event.payload.type==='message_complete');assert.equal(completed.length,1);
    assert.equal((completed[0]!.payload as {content:string}).content,'fresh result');
  }finally{release.resolve();h.connection.close();}
});

test('Zcode completion before the send acknowledgement is projected once and is not resurrected by late acknowledgement',async()=>{
  const events:Parameters<EngineConnectionOptions['onEvent']>[0][]=[],h=acp('zcode',()=>{},event=>events.push(event));h.transport.holdPrompt=true;
  try{h.connection.send('synthetic input');await until(()=>h.sends()===1);
    const complete=()=>h.transport.emitMessage({method:'session/event',params:{sessionId:'external',type:'turn.completed',payload:{response:'result'}}});
    complete();complete();assert.equal(events.filter(event=>event.payload.type==='message_complete').length,1);
    const sent=h.transport.sent.find(message=>message.method==='session/send');assert.ok(sent);h.transport.emitMessage({id:sent.id,result:{}});
    await tick();await tick();complete();assert.equal(events.filter(event=>event.payload.type==='message_complete').length,1);
  }finally{h.connection.close();}
});

test('Codex blocks both queued and newly arriving inputs until its external ID is persisted',async()=>{
  const entered=gate(),release=gate(),h=await codex(async()=>{entered.resolve();await release.promise;});try{
    h.connection.send('queued');await entered.promise;h.connection.send('arrived during persistence');await tick();assert.equal(h.methods.includes('turn/start'),false);release.resolve();await until(()=>h.methods.filter(x=>x==='turn/start').length===2);
  }finally{release.resolve();await h.cleanup();}
});

test('Codex actual thread callback waits for the Native identity and receipt transaction',async()=>{
  const f=fixture();f.mutate('UPDATE sessions SET engine_session_id=NULL');
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const runtime=createSessionRuntimeState({sessionId:'session',projectId:'project',engine:'codex'});
  runtime.attemptId='attempt';runtime.engineConnectionId='connection';runtime.leaseToken='lease';
  const bound=new StoredRuntimeEvents(runtime,port,{storeId:'store',generation:1,runtimeVersion:1,isOwned:()=>true,onFailure:()=>assert.fail('unexpected Native failure')});
  const entered=gate(),release=gate(),execute=port.execute.bind(port);
  port.execute=(async(request:any)=>{if(request.command.name==='turn.bindExternalSession'){entered.resolve();await release.promise;}return execute(request);}) as typeof port.execute;
  const h=await codex(()=>bound.sessionReady(null)('external'));
  try{h.connection.send('synthetic input');await entered.promise;assert.equal(h.methods.includes('turn/start'),false);
    release.resolve();await until(()=>h.methods.includes('turn/start'));assert.equal(f.scalar('SELECT codex_thread_id FROM sessions'),'external');
  }finally{release.resolve();await h.cleanup();await bound.close().catch(()=>{});await port.close();f.cleanup();}
});
test('Codex persistence failure prevents a turn and does not expose callback exception text',async()=>{
  const h=await codex(async()=>{throw Error('private synthetic persistence detail');});try{
    h.connection.send('queued');await until(()=>h.errors.length>0);assert.equal(h.methods.includes('turn/start'),false);assert.equal(h.errors.some(error=>error.includes('private synthetic')),false);
  }finally{await h.cleanup();}
});
test('Codex close or local queued cancellation during persistence cannot launch a late turn',async()=>{
  for(const close of [false,true]){const entered=gate(),release=gate(),h=await codex(async()=>{entered.resolve();await release.promise;});try{
    h.connection.send('queued');await entered.promise;if(close)h.connection.close();else await h.connection.cancel();release.resolve();await tick();await tick();assert.equal(h.methods.includes('turn/start'),false);
  }finally{release.resolve();await h.cleanup();}}
});
