import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverStoredStandalone } from '../services/stored-standalone-recovery.js';
import { fixture,markRead } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StoredRuntimeConnections } from './stored-runtime-connections.js';
import { StoredQueuedTurnDispatcher } from './stored-queued-turn-dispatch.js';
import { StoredProviderTurnScheduler } from '../engine/concurrency/stored-scheduler.js';
import { createSessionRuntimeState,prepareClaimedSessionRuntime,type SessionRuntime } from '../engine/runtime.js';
import { EngineRegistry } from '../engine/registry.js';
import type { EngineAdapter,EngineConnectionOptions,EngineEvent } from '../engine/adapter.js';
import { finishStoredAssistant } from './stored-assistant-terminal.js';
import { StoredRuntimeStop } from '../services/stored-runtime-stop.js';
import { FEISHU_HOST_CONTEXT, RELAY_HOST_CONTEXT, RELAY_HOST_CONTEXT_VERSION } from '../engine/host-context.js';
import { FEISHU_IM_SCHEMA_SQL } from '../storage/native-feishu-im.js';
import { feishuBotConfigSchema, normalizeFeishuInbound } from '../integrations/feishu-im/inbound.js';
import { feishuExecutionId, feishuExecutionResource } from '../integrations/feishu-im/native-session-scope.js';

const key='codex:default',system={kind:'system',purpose:'scheduler'} as const;
const feishuKey = feishuExecutionResource('codex');
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};};
async function until(check:()=>boolean){for(let i=0;i<200&&!check();i++)await new Promise<void>(r=>setTimeout(r,5));assert.ok(check(),'mock stage timed out');}
async function setup(nativeHost=false,acknowledge=true,auto=false,onRuntimeChanged?:()=>Promise<void>){
  const f=fixture();f.mutate('DELETE FROM engine_resource_leases');
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true,defaultConcurrency:{[key]:1,[feishuKey]:1}});
  let nextTurn=0,modelCalls=0,available=true,readyId='external',closeOnConnect=false,modelGate:ReturnType<typeof gate>|undefined,publishGate:ReturnType<typeof gate>|undefined;
  const hostViews:Array<()=>string|undefined>=[];
  let cancelGate:ReturnType<typeof gate>|undefined,cancelFails=false,cancelCalls=0;
  let beforeStartError=false,terminalHook:(()=>Promise<void>)|undefined;
  const raw:MockConnection[]=[],terminals:string[]=[],failures:string[]=[],failedDispatches:boolean[]=[];
  const streamEvents:any[]=[];
  class MockConnection {
    responses:unknown[]=[];
    sentPreferences: unknown[]=[];
    inputs:string[]=[];closed=false;closes=0;lastTurn='';sequence=0;ready:Promise<void>;
    constructor(readonly options:EngineConnectionOptions){const id=readyId;this.ready=Promise.resolve().then(async()=>{await options.onSessionReady(id);});void this.ready.catch(()=>{});}
    emit(payload:EngineEvent,turnId?:string){this.options.onEvent({engineId:'codex',payload,meta:{source:'realtime',observedAt:Date.now(),sequence:++this.sequence,
      eventId:`physical-${raw.indexOf(this)}:${this.sequence}`,externalSessionId:'external',...(turnId?{externalTurnId:turnId}:{})}});}
    send(content:string,options?:Parameters<import('../engine/adapter.js').EngineConnection['send']>[1]){this.sentPreferences.push(options?.preferences);void this.ready.then(()=>{if(this.closed)return;this.inputs.push(content);this.lastTurn=`turn-${++nextTurn}`;
      if(beforeStartError){this.emit({type:'error',diagnostic:{code:'CODEX_MODEL_UNAVAILABLE',phase:'send',retryable:false,userMessage:'synthetic model error'}},this.lastTurn);return;}
      this.emit({type:'turn_start',turnId:this.lastTurn},this.lastTurn);if(acknowledge)this.options.onInputAccepted?.(this.lastTurn,content);})
      .catch(()=>this.emit({type:'error',diagnostic:{code:'CODEX_SESSION_FAILED',phase:'connect',retryable:false,userMessage:'synthetic failure'}}));}
    finish(turn=this.lastTurn){this.emit({type:'message_complete',turnId:turn,content:`result:${turn}`},turn);}
    cancel(){cancelCalls++;return(cancelGate?.promise??Promise.resolve()).then(()=>{if(cancelFails)throw Error('synthetic unknown cancel');});}respondToInteraction(id:string|number,response:unknown){this.responses.push({id,response});}
    close(){if(this.closed)return;this.closed=true;this.closes++;this.options.onClosed();}
  }
  const registry=new EngineRegistry([{id:'codex',...(auto?{interactions:{normalize:(request:any)=>({id:'interaction:1',requestId:request.requestId,kind:'command',snapshot:{title:'synthetic'},availableActions:['accept_once','decline'],autoApprovable:true}),buildResponse:(_request:any,command:any)=>({decision:command.action})}}:{}),availability:{getCurrent:()=>({available,code:available?'AVAILABLE':'UNAVAILABLE'})},runtime:{connect:(options:EngineConnectionOptions)=>{
    const connection=new MockConnection(options);raw.push(connection);if(closeOnConnect)connection.close();return connection;
  }}} as unknown as EngineAdapter]);
  const runtimes=new Map<string,SessionRuntime>();
  const pool=new StoredRuntimeConnections({port,storeId:'store',generation:1,runtimes,registry,
    onRuntimeChanged,
    stream:{hub:{broadcastSession:async event=>{streamEvents.push(structuredClone(event));return{sent:1,failed:0};}}},
    prepareRuntime:async(claim,payload)=>{modelCalls++;await modelGate?.promise;const runtime=createSessionRuntimeState({sessionId:claim.sessionId,projectId:payload.session.projectId,engine:claim.engineId});
      prepareClaimedSessionRuntime(runtime,{projectId:payload.session.projectId,attemptId:claim.attemptId,resourceKey:claim.resourceKey,leaseToken:claim.leaseToken,
        requestedByUserId:claim.requestedByUserId,claimedAt:payload.claimedAt,preferences:{modelId:payload.session.modelId,reasoningEffort:payload.session.reasoningEffort,serviceTier:payload.session.serviceTier}});return runtime;},
    ...(nativeHost?{}:{hostContext:(_id:string,current:()=>{attemptId:string}|null)=>{hostViews.push(()=>current()?.attemptId);return{delivered:true,onDelivered:()=>{}};}}),onFailure:(_runtime,code)=>failures.push(code),
    onEvent:async(runtime,event,context)=>{
      if(event.payload.type==='delta')runtime.currentContent+=event.payload.content;
      if(event.payload.type==='message_complete')await finishStoredAssistant(runtime,event.payload,context,{messageId:`result-${runtime.attemptId}`,now:Date.now(),fileChanges:{}});
      if(event.payload.type==='error')await context.finishTerminal({id:`failed-${runtime.attemptId}`,turnId:context.fact?.externalTurnId||runtime.currentTurnId||runtime.attemptId!,content:'',items:null,metadata:null,durationMs:null});
    },
    onClosed:async(runtime,context)=>{await context.finishTerminal({id:`closed-${runtime.attemptId}`,turnId:runtime.currentTurnId||runtime.attemptId!,content:'',items:null,metadata:null,durationMs:null});},
    onTerminalCommitted:async(runtime)=>{if(runtime.attemptId==='attempt-1')await publishGate?.promise;await terminalHook?.();terminals.push(runtime.attemptId!);},
  });
  const dispatcher=new StoredQueuedTurnDispatcher(port,{prepare:(...args)=>pool.prepare(...args)});
  const scheduler=new StoredProviderTurnScheduler(port,{storeId:'store',generation:1,assertExclusiveWriter:async()=>{},onFailure:()=>{},
    start:(claim,context)=>dispatcher.start(claim,context),failed:async(_claim,_error,context)=>{failedDispatches.push(context.effectStarted);}});
  async function enqueue(n:number){const result=await port.execute({...markRead(),operationId:`enqueue-${n}`,command:{name:'turn.enqueue',input:{sessionId:'draft',attemptId:`attempt-${n}`,messageId:`user-${n}`,
    engineId:'codex',resourceKey:key,content:`input-${n}`,metadata:null,expectedPreferencesRevision:0,origin:{kind:'direct'},...(n===1?{draft:{projectId:'project',title:'test',titleManuallySet:false}}:{})}}});assert.equal(result.state,'committed');}
  async function claim(){const result=await port.execute({...markRead(),operationId:`claim-${Math.random()}`,principal:system,command:{name:'queue.claim',input:{resourceKey:key,claimToken:`token-${Math.random()}`}}});
    assert.equal(result.state,'committed');if(result.state!=='committed'||!result.value)throw Error('claim missing');return result.value;}
  async function prepare(){const selected=await claim(),payload=await port.readClaimedTurn({principal:system,claim:selected});assert.ok(payload);
    return{claim:selected,prepared:await pool.prepare(selected,payload,new AbortController().signal)};}
  async function finish(n:number){raw.at(-1)!.finish();await until(()=>terminals.includes(`attempt-${n}`));}
  return{f,port,pool,raw,runtimes,terminals,failures,failedDispatches,hostViews,streamEvents,enqueue,claim,prepare,finish,scheduler,modelCalls:()=>modelCalls,cancelCalls:()=>cancelCalls,
    cancellation:(value:ReturnType<typeof gate>,fails=false)=>{cancelGate=value;cancelFails=fails;},
    modelError:()=>{beforeStartError=true;},onTerminal:(hook:()=>Promise<void>)=>{terminalHook=hook;},
    unavailable:()=>{available=false;},
    models:(value:ReturnType<typeof gate>|undefined)=>{modelGate=value;},publication:(value:ReturnType<typeof gate>|undefined)=>{publishGate=value;},ready:(id:string)=>{readyId=id;},immediateClose:()=>{closeOnConnect=true;},
    cleanup:async()=>{modelGate?.resolve();publishGate?.resolve();cancelGate?.resolve();await scheduler.close();for(const connection of raw)connection.close();await port.close();f.cleanup();}};
}

test('a Feishu handoff supplies history on the first engine turn without altering the saved user message',async()=>{
  const h=await setup();try{
    h.f.mutate(FEISHU_IM_SCHEMA_SQL);
    await h.enqueue(1);
    h.f.mutate(`INSERT INTO feishu_im_matters(id,bot_id,tenant_key,chat_id,project_id,task_id,title,sender_id,created_at,updated_at)
      VALUES('matter','bot','tenant','chat','project','task','title','sender',1,1);
      INSERT INTO feishu_im_matter_sessions(session_id,matter_id,created_at,handoff) VALUES('draft','matter',1,'saved Feishu summary');`);
    await h.scheduler.drain(key);
    await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');
    assert.match(h.raw[0]!.inputs[0]!, /"saved Feishu summary"[\s\S]+input-1$/);
    assert.equal(h.f.scalar("SELECT content FROM messages WHERE id='user-1'"),'input-1');
    await h.finish(1);
    await h.enqueue(2);
    await h.scheduler.drain(key);
    await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-2');
    assert.equal(h.raw.at(-1)!.inputs.at(-1),'input-2');
    await h.finish(2);
  }finally{await h.cleanup();}
});

test('Native async questions reserve one answer atomically, release an unsent cancelled answer and preserve late questions independently',async()=>{
  const h=await setup();try{
    await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');
    const question={type:'agentMessage',id:'question-source',status:'completed',delivery:'async',questions:[{title:'Pick an option',options:['A','B']}]};
    h.raw[0]!.emit({type:'item_complete',item:question},'turn-1');await until(()=>h.runtimes.get('draft')!.turnItems.some(item=>item.id==='async-question:question-source'));
    const principal={kind:'user',userId:'owner',authSessionHash:'auth-owner'} as const;
    const can=(messageId:string)=>h.port.checkAsyncQuestionAnswer({principal,sessionId:'draft',questionId:'async-question:question-source',messageId});
    assert.equal(await can('answer-a'),true);
    const answers=await Promise.all(['answer-a','answer-b'].map(messageId=>h.port.execute({...markRead(),operationId:messageId,command:{name:'followup.submit',input:{sessionId:'draft',messageId,content:'answer',attachments:[],replyToAsyncQuestionId:'async-question:question-source',origin:null}}})));
    assert.equal(answers.filter(result=>result.state==='committed').length,1);assert.equal(answers.filter(result=>result.state==='rejected').length,1);
    const winner=answers[0]!.state==='committed'?'answer-a':'answer-b';assert.equal(await can('another-answer'),false);
    const published=h.streamEvents.filter(event=>event.type==='item_start'&&event.item.id==='async-question:question-source').length;
    h.raw[0]!.emit({type:'item_complete',item:question},'turn-1');await h.pool.getBinding('draft')!.events.storage.drain();
    assert.equal(h.streamEvents.filter(event=>event.type==='item_start'&&event.item.id==='async-question:question-source').length,published);
    const cancelled=await h.port.execute({...markRead(),operationId:'cancel-answer',command:{name:'followup.transition',input:{sessionId:'draft',id:winner,from:'received',to:'cancelled',errorCode:null}}});assert.equal(cancelled.state,'committed');assert.equal(await can('another-answer'),true);
    const other=await h.port.checkAsyncQuestionAnswer({principal:{kind:'user',userId:'other',authSessionHash:'auth-other'},sessionId:'draft',questionId:'async-question:question-source',messageId:'other-answer'});assert.equal(other,false);
    await h.finish(1);
    const terminalOperation=String(h.f.scalar("SELECT operation_id FROM _relay_storage_operations WHERE scope_session_id='draft' AND command_name='turn.finishFromFact'"));
    const receipt=await h.port.lookup({storeId:'store',operationId:terminalOperation,principal:{kind:'system',purpose:'recovery'}});
    assert.equal(receipt.state,'committed');
    if(receipt.state==='committed'&&receipt.commandName==='turn.finishFromFact')assert.equal(receipt.value.savedMessage.items,h.f.scalar("SELECT items FROM messages WHERE session_id='draft' AND role='assistant'"));
    const late={type:'agentMessage',id:'late-question',status:'completed',delivery:'async',questions:[{title:'A late question'}]};
    h.raw[0]!.emit({type:'item_complete',item:late},'turn-1');await until(()=>h.f.scalar("SELECT count(*) FROM messages WHERE session_id='draft' AND phase='interaction'")===1);
    h.raw[0]!.emit({type:'item_complete',item:late},'turn-1');await h.pool.getBinding('draft')!.events.storage.drain();
    assert.equal(h.f.scalar("SELECT count(*) FROM messages WHERE session_id='draft' AND phase='interaction'"),1);
    assert.equal(h.f.scalar("SELECT status FROM sessions WHERE id='draft'"),'completed');assert.deepEqual(h.failures,[]);
  }finally{await h.cleanup();}
});

test('standalone request after terminal gates new work and saves an independent interaction without changing the task result',async()=>{
  const h=await setup();try{
    await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');await h.finish(1);
    const result=h.f.scalar("SELECT outcome FROM engine_terminal_decisions WHERE session_id='draft'");
    h.raw[0]!.emit({type:'server_request',requestId:99,method:'synthetic/unsupported',params:{}});
    await until(()=>h.runtimes.get('draft')!.pendingInteractions.size===1);
    assert.equal(h.f.scalar("SELECT status FROM sessions WHERE id='draft'"),'awaiting_action');
    assert.equal(h.runtimes.get('draft')!.isRunning,false);
    const blocked=await h.port.execute({...markRead(),operationId:'standalone-blocked',command:{name:'turn.enqueue',input:{sessionId:'draft',attemptId:'blocked-attempt',messageId:'blocked-message',engineId:'codex',resourceKey:key,content:'blocked',metadata:null,expectedPreferencesRevision:0,origin:{kind:'direct'}}}});
    assert.equal(blocked.state,'rejected');
    h.raw[0]!.emit({type:'server_request_resolved',requestId:99});
    await until(()=>h.runtimes.get('draft')!.pendingInteractions.size===0);
    assert.equal(h.f.scalar("SELECT status FROM sessions WHERE id='draft'"),'completed');
    assert.equal(h.f.scalar("SELECT outcome FROM engine_terminal_decisions WHERE session_id='draft'"),result);
    assert.equal(h.f.scalar("SELECT count(*) FROM messages WHERE session_id='draft' AND phase='interaction'"),1);
    assert.equal(h.f.scalar("SELECT count(*) FROM engine_terminal_decisions WHERE session_id='draft'"),1);
    await h.enqueue(2);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-2');await h.finish(2);
    assert.equal(h.raw.length,1);assert.deepEqual(h.failures,[]);
  }finally{await h.cleanup();}
});

test('closed standalone connection saves an incomplete request while preserving the terminal task',async()=>{
  const h=await setup();try{
    await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');await h.finish(1);
    h.raw[0]!.emit({type:'server_request',requestId:99,method:'synthetic/unsupported',params:{}});
    await until(()=>h.runtimes.get('draft')!.pendingInteractions.size===1);h.raw[0]!.close();
    await until(()=>h.runtimes.get('draft')!.pendingInteractions.size===0);
    assert.equal(h.f.scalar("SELECT status FROM sessions WHERE id='draft'"),'completed');
    assert.equal(h.f.scalar("SELECT json_extract(items,'$[0].status') FROM messages WHERE session_id='draft' AND phase='interaction'"),'incomplete');
    assert.equal(h.f.scalar("SELECT json_extract(items,'$[0].details.resolvedAction') FROM messages WHERE session_id='draft' AND phase='interaction'"),null);
    assert.deepEqual(h.failures,[]);
  }finally{await h.cleanup();}
});

test('cold restart closes unsubmitted standalone requests and never replays an uncertain response',async()=>{
  const h=await setup();let reopened:StorageWorkerClient|undefined;
  try{
    await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');await h.finish(1);
    h.raw[0]!.emit({type:'server_request',requestId:98,method:'synthetic/unsupported',params:{}});
    h.raw[0]!.emit({type:'server_request',requestId:99,method:'synthetic/unsupported',params:{}});
    await until(()=>h.runtimes.get('draft')!.pendingInteractions.size===2);
    const interactionId=[...h.runtimes.get('draft')!.pendingInteractions.keys()][1]!;
    const owner=h.f.scalar(`SELECT request_digest FROM _relay_standalone_interactions WHERE interaction_id='${interactionId}'`);
    const binding=h.pool.getBinding('draft')!;
    const prepared=await h.port.execute({...markRead(),operationId:'standalone-unknown',command:{name:'interaction.prepareResponse',input:{sessionId:'draft',attemptId:'attempt-1',connectionId:binding.runtime.engineConnectionId!,runtimeVersion:binding.version,interactionId,requestDigest:String(owner),responseDigest:'a'.repeat(64),claimToken:'unknown-claim',standalone:true}}});assert.equal(prepared.state,'committed');
    await h.port.close();reopened=await StorageWorkerClient.open({filename:h.f.filename,storeId:'store',generation:2});
    const result=await recoverStoredStandalone({port:reopened,storeId:'store',generation:2,assertExclusiveWriter:async()=>{}});
    assert.equal(result.closed,1);assert.deepEqual(result.blocked,[{interactionId,sessionId:'draft',phase:'prepared'}]);
    assert.equal(h.f.scalar("SELECT status FROM sessions WHERE id='draft'"),'awaiting_action');
    assert.equal(h.f.scalar("SELECT count(*) FROM messages WHERE session_id='draft' AND phase='interaction'"),1);
    assert.equal(h.raw[0]!.responses.length,0);
    assert.equal((await recoverStoredStandalone({port:reopened,storeId:'store',generation:2,assertExclusiveWriter:async()=>{}})).closed,0);
  }finally{await reopened?.close();await h.cleanup();}
});

test('Native trust can submit one standalone approval on the retained terminal connection',async()=>{
  const h=await setup(false,true,true);try{
    await h.enqueue(1);
    const trust=await h.port.execute({...markRead(),operationId:'standalone-trust',command:{name:'approvalTrust.set',input:{scope:'session',scopeId:'draft',mode:'trusted',duration:'one_hour'}}});assert.equal(trust.state,'committed');
    await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');await h.finish(1);
    h.raw[0]!.emit({type:'server_request',requestId:99,method:'execCommandApproval',params:{}});
    await until(()=>h.f.scalar("SELECT count(*) FROM _relay_standalone_interactions WHERE phase='resolved'")===1);
    await until(()=>h.runtimes.get('draft')!.pendingInteractions.size===0);
    assert.equal(h.raw[0]!.responses.length,1);assert.equal(h.f.scalar("SELECT status FROM sessions WHERE id='draft'"),'completed');
    assert.equal(h.f.scalar("SELECT phase FROM _relay_interaction_responses"),'submitted');assert.deepEqual(h.failures,[]);
  }finally{await h.cleanup();}
});

test('Native trust authorizes one automatic response; revocation before dispatch leaves a manual request',async()=>{
  for(const revoke of [false,true]){
    const h=await setup(false,true,true);try{
      await h.enqueue(1);
      const trust=await h.port.execute({...markRead(),operationId:'set-trust',command:{name:'approvalTrust.set',input:{scope:'session',scopeId:'draft',mode:'trusted',duration:'one_hour'}}});assert.equal(trust.state,'committed');
      const execute=h.port.execute.bind(h.port);
      if(revoke)h.port.execute=(async(request:any)=>{if(request.command.name==='turn.authorizeAutoResponse')await execute({...markRead(),operationId:'clear-trust',command:{name:'approvalTrust.clear',input:{scope:'session',scopeId:'draft'}}});return execute(request);}) as typeof h.port.execute;
      await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');
      h.raw[0]!.emit({type:'server_request',requestId:1,method:'execCommandApproval',params:{}},'turn-1');
      await until(()=>h.streamEvents.some(e=>e.type==='item_start'||e.type==='item_complete'));
      assert.equal(h.raw[0]!.responses.length,revoke?0:1);
      assert.equal(h.runtimes.get('draft')!.pendingInteractions.size,revoke?1:0);
      if(revoke){h.raw[0]!.emit({type:'server_request_resolved',requestId:1},'turn-1');await until(()=>h.runtimes.get('draft')!.pendingInteractions.size===0);}
      else assert.equal(h.f.scalar('SELECT phase FROM _relay_interaction_responses'),'submitted');
      await h.finish(1);assert.deepEqual(h.failures,[]);
    }finally{await h.cleanup();}
  }
});
test('active Native requests persist awaiting-action state and resolve by a turn-scoped request identity',async()=>{
  const h=await setup();try{
    await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');
    const request={type:'server_request' as const,requestId:1,method:'synthetic/unsupported',params:{}};
    h.raw[0]!.emit(request,'turn-1');h.raw[0]!.emit(request,'turn-1');
    await until(()=>h.runtimes.get('draft')!.pendingInteractions.size===1);
    assert.equal(h.f.scalar("SELECT status FROM sessions WHERE id='draft'"),'awaiting_action');
    h.raw[0]!.emit({type:'server_request_resolved',requestId:1},'turn-1');
    await until(()=>h.runtimes.get('draft')!.pendingInteractions.size===0);
    assert.equal(h.f.scalar("SELECT status FROM sessions WHERE id='draft'"),'processing');
    await h.finish(1);assert.deepEqual(h.failures,[]);
  }finally{await h.cleanup();}
});
test('actual Native connection projects stream and merged tools before saving the terminal snapshot',async()=>{
  const h=await setup();try{
    await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');
    h.raw[0]!.emit({type:'delta',itemId:'narrative',phase:'commentary',content:'progress'},'turn-1');
    h.raw[0]!.emit({type:'item_start',item:{id:'tool',type:'commandExecution',status:'in_progress',details:{command:'echo test'}}},'turn-1');
    h.raw[0]!.emit({type:'item_complete',item:{id:'tool',type:'commandExecution',status:'completed',details:{output:'test'}}},'turn-1');
    await until(()=>h.streamEvents.some(e=>e.type==='item_complete'));
    assert.equal(h.runtimes.get('draft')!.currentContent,'progress');
    assert.equal(h.streamEvents[0].type,'turn_start');
    await h.finish(1);
    const saved=String(h.f.scalar("SELECT items FROM messages WHERE id='result-attempt-1'"));
    assert.match(saved,/echo test/);assert.match(saved,/test/);
    const before=h.streamEvents.length;h.raw[0]!.emit({type:'delta',itemId:'old',content:'late'},'turn-1');
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(h.streamEvents.length,before);
    assert.deepEqual(h.failures,[]);
  }finally{await h.cleanup();}
});
test('late protocol acknowledgement cannot mark a finished Native attempt and next send supplements again',async()=>{
  const h=await setup(true,false);const warn=console.warn;const warnings:unknown[]=[];
  console.warn=(...args)=>{warnings.push(args);};
  try{
    await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.raw[0]?.inputs.length===1);await h.finish(1);
    h.raw[0]!.options.onInputAccepted!('turn-1',h.raw[0]!.inputs[0]!);
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(warnings.length,1);
    assert.equal(String(h.f.scalar("SELECT engine_metadata FROM sessions WHERE id='draft'")).includes('relayHostContext'),false);
    await h.enqueue(2);await h.scheduler.drain(key);await until(()=>h.raw[0]?.inputs.length===2);
    assert.equal(h.raw[0]!.inputs[1],`${RELAY_HOST_CONTEXT}\n\ninput-2`);await h.finish(2);
    assert.deepEqual(h.failures,[]);
  }finally{console.warn=warn;await h.cleanup();}
});
test('Native host delivery commits before terminal and reused connections reload the marker',async()=>{
  const h=await setup(true);try{
    await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.raw[0]?.inputs.length===1);
    assert.equal(h.raw[0]!.inputs[0],`${RELAY_HOST_CONTEXT}\n\ninput-1`);await h.finish(1);
    assert.match(String(h.f.scalar("SELECT engine_metadata FROM sessions WHERE id='draft'")),/relayHostContext/);
    assert.equal(h.f.scalar("SELECT content FROM messages WHERE id='user-1'"),'input-1');
    await h.enqueue(2);await h.scheduler.drain(key);await until(()=>h.raw[0]?.inputs.length===2);
    assert.equal(h.raw.length,1);assert.equal(h.raw[0]!.inputs[1],'input-2');
    // A replay from the old turn must not remove the current turn's marker.
    h.raw[0]!.emit({type:'system_notice',noticeType:'context_compaction',title:'old'},'turn-1');
    await h.finish(2);
    assert.match(String(h.f.scalar("SELECT engine_metadata FROM sessions WHERE id='draft'")),/relayHostContext/);
    await h.enqueue(3);await h.scheduler.drain(key);await until(()=>h.raw[0]?.inputs.length===3);
    h.raw[0]!.emit({type:'system_notice',noticeType:'context_compaction',title:'compacted'},'turn-3');
    await h.finish(3);
    assert.equal(String(h.f.scalar("SELECT engine_metadata FROM sessions WHERE id='draft'" )).includes('relayHostContext'),false);
    await h.enqueue(4);await h.scheduler.drain(key);await until(()=>h.raw[0]?.inputs.length===4);
    assert.equal(h.raw[0]!.inputs[3],`${RELAY_HOST_CONTEXT}\n\ninput-4`);await h.finish(4);
    assert.deepEqual(h.failures,[]);
  }finally{await h.cleanup();}
});

test('Feishu group sends update the host marker and use the current sender when quoting another speaker', async () => {
  const h = await setup(true);
  const workspacePath = 'D:/synthetic';
  const configurationId = '00000000-0000-4000-8000-000000000001';
  const bot = { ...feishuBotConfigSchema.parse({ id: configurationId, appId: 'cli_a', appSecret: 'test', projectId: 'project' }),
    workspaceName: 'Test', workspacePath };
  try {
    h.f.mutate(FEISHU_IM_SCHEMA_SQL);
    h.f.mutate(`INSERT INTO feishu_im_settings VALUES('${configurationId}','cli_a','project','Test',1,1,'{}','secret',NULL)`);
    for (const n of [1, 2]) {
      const senderDisplayName = n === 1 ? '张三' : '李四';
      const inbound = normalizeFeishuInbound(bot, 'ou_bot', { app_id: 'cli_a', tenant_key: 'tenant',
        sender: { sender_type: 'user', sender_id: { open_id: n === 1 ? 'ou_alice' : 'ou_bob' } },
        message: { chat_type: 'group', chat_id: 'oc_group', message_id: `om_input_${n}`, message_type: 'text',
          ...(n === 2 ? { parent_id: 'om_input_1' } : {}), mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
          content: JSON.stringify({ text: `@_user_1 input-${n}` }) } });
      assert.ok(inbound);
      h.f.mutate(`INSERT OR IGNORE INTO feishu_im_user_access VALUES('${inbound.botId}','${inbound.tenantKey}','${inbound.projectId}','${inbound.senderId}')`);
      assert.equal(await h.port.acceptFeishuInbound({ inbound, workspacePath }), 'received');
      const scope = { botId: inbound.botId, tenantKey: inbound.tenantKey, workspacePath };
      const pending = await h.port.runFeishuWork({ ...scope, action: 'pending' });
      assert.ok(pending?.kind === 'inbound');
      const mapped = await h.port.runFeishuWork({ ...scope, action: 'prepareRelayTurn', sequence: pending.sequence, engineId: 'codex', configurationId, senderDisplayName });
      assert.ok(mapped?.kind === 'relayTurnPrepared');
      if (n === 2) assert.equal(mapped.turn.referenced, true);
      const { sessionId, messageId } = mapped.turn;
      const attemptId = feishuExecutionId([messageId, 'attempt']);
      if (n === 1) {
        const metadata = JSON.stringify({ relayHostContext: { version: RELAY_HOST_CONTEXT_VERSION, externalSessionId: 'external', compactionCount: 0 } });
        h.f.mutate(`UPDATE sessions SET engine_session_id='external',engine_metadata='${metadata}' WHERE id='${sessionId}'`);
      }
      const enqueued = await h.port.execute({ ...markRead(), principal: system, operationId: `enqueue-feishu-${n}`,
        command: { name: 'turn.enqueue', input: { sessionId, messageId, attemptId, engineId: 'codex', resourceKey: feishuKey,
          content: mapped.content, metadata: null, expectedPreferencesRevision: mapped.preferencesRevision,
          origin: { kind: 'feishu', botId: scope.botId, tenantKey: scope.tenantKey, sequence: pending.sequence } } } });
      assert.equal(enqueued.state, 'committed');
      await h.scheduler.drain(feishuKey);
      await until(() => h.raw[0]?.inputs.length === n);
      const input = h.raw[0]!.inputs[n - 1]!;
      if (n === 1) {
        assert.ok(input.startsWith(`${FEISHU_HOST_CONTEXT.text}\n\n`));
        assert.match(input, /当前对话通过 Relay 平台接入，用户通过飞书聊天与你交互。/);
        assert.doesNotMatch(input, /用户通过 Relay 界面/);
      } else {
        assert.doesNotMatch(input, /<relay_host_context>/);
      }
      assert.ok(input.includes(`本轮发言人（飞书显示名）：${JSON.stringify(senderDisplayName)}`));
      if (n === 2) assert.doesNotMatch(input, /张三/);
      assert.match(input, /本轮用户消息：\ninput-\d$/);
      h.raw[0]!.finish();
      await until(() => h.terminals.includes(attemptId));
      const metadata = JSON.parse(String(h.f.scalar(`SELECT engine_metadata FROM sessions WHERE id='${sessionId}'`)));
      assert.equal(metadata.relayHostContext.version, FEISHU_HOST_CONTEXT.version);
      assert.equal(h.f.scalar(`SELECT content FROM messages WHERE id='${messageId}'`), `input-${n}`);
      await h.port.runFeishuWork({ ...scope, action: 'prepare', sequence: pending.sequence, response: null });
    }
    assert.deepEqual(h.failures, []);
  } finally { await h.cleanup(); }
});

test('Feishu private peer is introduced once and can be supplemented after compaction or a missing name', async () => {
  const h = await setup(true);
  const workspacePath = 'D:/synthetic';
  const configurationId = '00000000-0000-4000-8000-000000000001';
  const bot = { ...feishuBotConfigSchema.parse({ id: configurationId, appId: 'cli_a', appSecret: 'test', projectId: 'project' }),
    workspaceName: 'Test', workspacePath };
  try {
    h.f.mutate(FEISHU_IM_SCHEMA_SQL);
    h.f.mutate(`INSERT INTO feishu_im_settings VALUES('${configurationId}','cli_a','project','Test',1,1,'{}','secret',NULL)`);
    const steps = [
      { name: '张"三', host: true, intro: true },
      { name: '张三', compact: true },
      { host: true },
      { name: '张三', intro: true },
      { name: '张三' },
    ];
    for (const [index, step] of steps.entries()) {
      const n = index + 1;
      const inbound = normalizeFeishuInbound(bot, 'ou_bot', { app_id: 'cli_a', tenant_key: 'tenant',
        sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
        message: { chat_type: 'p2p', chat_id: 'oc_private', message_id: `om_private_${n}`, message_type: 'text',
          content: JSON.stringify({ text: `input-${n}` }) } });
      assert.ok(inbound);
      h.f.mutate(`INSERT OR IGNORE INTO feishu_im_user_access VALUES('${inbound.botId}','${inbound.tenantKey}','${inbound.projectId}','${inbound.senderId}')`);
      assert.equal(await h.port.acceptFeishuInbound({ inbound, workspacePath }), 'received');
      const scope = { botId: inbound.botId, tenantKey: inbound.tenantKey, workspacePath };
      const pending = await h.port.runFeishuWork({ ...scope, action: 'pending' });
      assert.ok(pending?.kind === 'inbound');
      const mapped = await h.port.runFeishuWork({ ...scope, action: 'prepareRelayTurn', sequence: pending.sequence, engineId: 'codex', configurationId,
        ...(step.name ? { senderDisplayName: step.name } : {}) });
      assert.ok(mapped?.kind === 'relayTurnPrepared');
      const { sessionId, messageId } = mapped.turn;
      const attemptId = feishuExecutionId([messageId, 'attempt']);
      const enqueued = await h.port.execute({ ...markRead(), principal: system, operationId: `enqueue-private-${n}`,
        command: { name: 'turn.enqueue', input: { sessionId, messageId, attemptId, engineId: 'codex', resourceKey: feishuKey,
          content: mapped.content, metadata: null, expectedPreferencesRevision: mapped.preferencesRevision,
          origin: { kind: 'feishu', botId: scope.botId, tenantKey: scope.tenantKey, sequence: pending.sequence } } } });
      assert.equal(enqueued.state, 'committed');
      await h.scheduler.drain(feishuKey);
      await until(() => h.raw[0]?.inputs.length === n);
      const input = h.raw[0]!.inputs[index]!;
      assert.equal(input.startsWith(FEISHU_HOST_CONTEXT.text), !!step.host);
      assert.equal(input.includes('当前私聊对象（飞书显示名）：'), !!step.intro);
      if (step.intro) assert.ok(input.includes(`当前私聊对象（飞书显示名）：${JSON.stringify(step.name)}\n显示名仅用于识别对话对象。`));
      assert.doesNotMatch(input, /本轮发言人（飞书显示名）/);
      assert.ok(input.endsWith(`本轮用户消息：\ninput-${n}`));
      if (step.compact) h.raw[0]!.emit({ type: 'system_notice', noticeType: 'context_compaction', title: 'compacted' }, `turn-${n}`);
      h.raw[0]!.finish();
      await until(() => h.terminals.includes(attemptId));
      const metadata = JSON.parse(String(h.f.scalar(`SELECT engine_metadata FROM sessions WHERE id='${sessionId}'`)));
      assert.equal(metadata.relayHostContext?.privatePeerIncluded, n === 1 || n >= 4 ? true : undefined);
      assert.equal(h.f.scalar(`SELECT content FROM messages WHERE id='${messageId}'`), `input-${n}`);
      await h.port.runFeishuWork({ ...scope, action: 'prepare', sequence: pending.sequence, response: null });
    }
    assert.deepEqual(h.failures, []);
  } finally { await h.cleanup(); }
});

test('actual registry/dispatcher reuses a physical connection with new Native attempts and fences old turn events',async()=>{
  const h=await setup();try{await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');
    h.runtimes.get('draft')!.currentContent='buffered stream';h.runtimes.get('draft')!.turnItems=[{id:'tool',type:'commandExecution',status:'completed',aggregatedOutput:'x'.repeat(100_000)}];
    await h.finish(1);assert.equal(h.runtimes.get('draft')!.turnItems.length,0);assert.equal(h.runtimes.get('draft')!.currentContent,'');
    const oldConnection=h.runtimes.get('draft')!.engineConnection!;
    await h.enqueue(2);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-2');
    assert.equal(h.raw.length,1);assert.equal(h.raw[0]!.closes,0);assert.deepEqual(h.raw[0]!.inputs,['input-1','input-2']);
    assert.equal(h.hostViews.length,1);assert.equal(h.hostViews[0]!(),'attempt-2');
    assert.throws(()=>oldConnection.send('stale send'),{code:'CONFLICT'});await assert.rejects(async()=>oldConnection.cancel(),{code:'CONFLICT'});oldConnection.close();assert.equal(h.raw[0]!.closes,0);
    h.raw[0]!.finish('turn-1');h.raw[0]!.emit({type:'delta',itemId:'old',content:'old output'},'turn-1');
    await new Promise<void>(r=>setImmediate(r));assert.deepEqual(h.terminals,['attempt-1']);assert.equal(h.runtimes.get('draft')!.currentContent,'');
    await h.finish(2);assert.equal(h.f.scalar('SELECT count(*) FROM engine_terminal_decisions'),2);assert.equal(h.failures.length,0);
    await h.pool.closeSession('draft');assert.equal(h.raw[0]!.closes,1);assert.equal(h.runtimes.has('draft'),false);
  }finally{await h.cleanup();}
});
test('connect and send use the prepared model defaults instead of nullable claim preferences',async()=>{
  const h=await setup();try{
    await h.enqueue(1);const selected=await h.prepare();const runtime=h.runtimes.get('draft')!;
    runtime.turnModelSnapshot={preferences:{modelId:null,reasoningEffort:null,serviceTier:null},displayNames:{},
      defaultModelId:'configured',modelDefaults:{configured:{reasoningEffort:'high',serviceTier:'default'}},modelInfo:null};
    await selected.prepared.invoke();await selected.prepared.release({invoked:true});
    await until(()=>runtime.currentTurnId==='turn-1');
    const expected={modelId:'configured',reasoningEffort:'high',serviceTier:'default'};
    assert.deepEqual(h.raw[0]!.options.initialTurnOptions?.preferences,expected);
    assert.deepEqual(h.raw[0]!.sentPreferences,[expected]);await h.finish(1);
  }finally{await h.cleanup();}
});
test('unused first preparation creates no physical connection and releases only its Native registration',async()=>{
  const h=await setup();try{await h.enqueue(1);const selected=await h.prepare();assert.equal(h.raw.length,0);await selected.prepared.release({invoked:false});
    assert.equal(h.runtimes.size,0);assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
  }finally{await h.cleanup();}
});
test('aborting a prepared continuation preserves the old process and allows a later turn',async()=>{
  const h=await setup();try{await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');await h.finish(1);
    await h.enqueue(2);const selected=await h.prepare();await selected.prepared.release({invoked:false});assert.equal(h.raw[0]!.closes,0);
    assert.equal(h.runtimes.get('draft')!.attemptId,'attempt-1');
    const result=await h.port.execute({...markRead(),operationId:'finish-unstarted',principal:system,command:{name:'queue.finishUnstarted',input:{claim:selected.claim,messageId:'unstarted-result'}}});assert.equal(result.state,'committed');
    await h.enqueue(3);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-2');await h.finish(3);assert.equal(h.raw.length,1);
  }finally{await h.cleanup();}
});
test('active or unknown attempts cannot be disposed as idle connections',async()=>{
  const h=await setup();try{await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');
    await assert.rejects(h.pool.closeSession('draft'),{code:'CONFLICT'});assert.equal(h.raw[0]!.closes,0);await h.finish(1);
  }finally{await h.cleanup();}
});
test('continuation waits for the previous committed publication to drain before replacing its runtime',async()=>{
  const h=await setup(),release=gate();try{h.publication(release);await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');
    h.raw[0]!.finish();await until(()=>h.f.scalar('SELECT count(*) FROM engine_resource_leases')===0);await h.enqueue(2);
    const next=h.scheduler.drain(key);await new Promise<void>(r=>setTimeout(r,20));assert.deepEqual(h.raw[0]!.inputs,['input-1']);
    release.resolve();await next;await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-2');await h.finish(2);assert.equal(h.raw.length,1);
  }finally{release.resolve();await h.cleanup();}
});
test('idle reconnection preserves the external ID and refuses a provider-created replacement thread',async()=>{
  const h=await setup();try{await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');await h.finish(1);await h.pool.closeSession('draft');
    h.ready('wrong-new-thread');await h.enqueue(2);await h.scheduler.drain(key);await until(()=>h.failures.length>0);
    assert.equal(h.raw[1]!.options.externalSessionId,'external');assert.equal(h.raw[1]!.inputs.length,0);
    assert.equal(h.f.scalar("SELECT engine_session_id FROM sessions WHERE id='draft'"),'external');assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
    await assert.rejects(h.pool.closeSession('draft'),{code:'CONFLICT'});
  }finally{await h.cleanup();}
});
test('transport close between preparation and dispatch settles a real local failure without sending',async()=>{
  const h=await setup();try{await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');await h.finish(1);
    await h.enqueue(2);const selected=await h.prepare();h.raw[0]!.close();await selected.prepared.invoke();await selected.prepared.release({invoked:true});
    assert.deepEqual(h.raw[0]!.inputs,['input-1']);assert.equal(h.f.scalar("SELECT status FROM sessions WHERE id='draft'"),'failed');assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
  }finally{await h.cleanup();}
});
test('source changes during model preparation invalidate dispatch and release the unused runtime',async()=>{
  const h=await setup(),release=gate();try{h.models(release);await h.enqueue(1);const run=h.scheduler.drain(key);
    await until(()=>h.modelCalls()===1);assert.equal(h.raw.length,0);
    h.f.mutate("UPDATE messages SET content='changed input' WHERE id='user-1'");release.resolve();await run;
    assert.deepEqual(h.failedDispatches,[false]);assert.equal(h.raw.length,0);assert.equal(h.runtimes.size,0);
  }finally{release.resolve();await h.cleanup();}
});
test('a synchronous transport close during connect settles before any send and does not misreport storage failure',async()=>{
  const h=await setup();try{h.immediateClose();await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.terminals.length===1);
    assert.equal(h.raw[0]!.inputs.length,0);assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
    assert.deepEqual(h.failedDispatches,[]);assert.deepEqual(h.failures,[]);
  }finally{await h.cleanup();}
});
test('Native stop in flight must settle before the shared physical connection can start a new attempt',async()=>{
  const h=await setup(),release=gate();let stop:StoredRuntimeStop|undefined;try{
    h.cancellation(release);await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');
    stop=new StoredRuntimeStop(h.port,{storeId:'store',generation:1,assertExclusiveWriter:async()=>{},getBinding:id=>h.pool.getBinding(id),onStopped:async()=>assert.fail('natural completion wins this race')});
    const stopping=stop.request({kind:'user',userId:'owner',authSessionHash:'auth-owner'},{sessionId:'draft',expectedAttemptId:'attempt-1'},'stop-1');
    await until(()=>h.cancelCalls()===1);await h.finish(1);await assert.rejects(h.pool.closeSession('draft'),{code:'CONFLICT'});await h.enqueue(2);const next=h.scheduler.drain(key);
    await new Promise<void>(r=>setTimeout(r,20));assert.deepEqual(h.raw[0]!.inputs,['input-1']);
    release.resolve();assert.deepEqual(await stopping,{state:'requested',confirmed:false});await next;
    await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-2');await h.finish(2);assert.equal(h.raw.length,1);assert.equal(h.cancelCalls(),1);
  }finally{release.resolve();await stop?.close();await h.cleanup();}
});
test('an uncertain physical cancel fences connection reuse after a natural terminal',async()=>{
  const h=await setup(),release=gate();let stop:StoredRuntimeStop|undefined;try{
    h.cancellation(release,true);await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');
    stop=new StoredRuntimeStop(h.port,{storeId:'store',generation:1,assertExclusiveWriter:async()=>{},getBinding:id=>h.pool.getBinding(id),onStopped:async()=>assert.fail('unknown cancel is not confirmed')});
    const stopping=stop.request({kind:'user',userId:'owner',authSessionHash:'auth-owner'},{sessionId:'draft',expectedAttemptId:'attempt-1'},'stop-unknown');
    await until(()=>h.cancelCalls()===1);await h.finish(1);release.resolve();assert.deepEqual(await stopping,{state:'unknown'});
    await h.enqueue(2);await h.scheduler.drain(key);assert.deepEqual(h.failedDispatches,[false]);assert.deepEqual(h.raw[0]!.inputs,['input-1']);assert.equal(h.raw[0]!.closes,0);
  }finally{release.resolve();await stop?.close();await h.cleanup();}
});
test('a scoped model error before turn_start commits failure instead of leaving a claimed attempt stuck',async()=>{
  const h=await setup();try{h.modelError();await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.terminals.length===1);
    assert.equal(h.f.scalar("SELECT status FROM sessions WHERE id='draft'"),'failed');assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
    assert.equal(h.f.scalar("SELECT count(*) FROM engine_turn_facts WHERE fact_type='turn_started'"),0);
    assert.equal(h.f.scalar("SELECT reason_code FROM engine_terminal_decisions WHERE attempt_id='attempt-1'"),'CODEX_MODEL_UNAVAILABLE');
  }finally{await h.cleanup();}
});
test('retirement blocks concurrent preparation before models or new Native binding are installed',async()=>{
  const h=await setup(),entered=gate(),release=gate();let closing:Promise<void>|undefined;
  try{await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');await h.finish(1);
    const retire=h.port.retireRuntime.bind(h.port);let paused=false;
    h.port.retireRuntime=async request=>{if(!paused){paused=true;entered.resolve();await release.promise;}return retire(request);};
    closing=h.pool.closeSession('draft');await entered.promise;await h.enqueue(2);await h.scheduler.drain(key);
    assert.equal(h.modelCalls(),1,'retiring connection must be fenced before model preparation');assert.deepEqual(h.raw[0]!.inputs,['input-1']);
  }finally{release.resolve();await closing?.catch(()=>{});await h.cleanup();}
});
test('concurrent idle closes share a single Native retirement',async()=>{
  const h=await setup(),entered=gate(),release=gate();let first:Promise<void>|undefined,second:Promise<void>|undefined;
  try{await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');await h.finish(1);
    const retire=h.port.retireRuntime.bind(h.port);let calls=0;
    h.port.retireRuntime=async request=>{calls++;entered.resolve();await release.promise;return retire(request);};
    first=h.pool.closeSession('draft');await entered.promise;second=h.pool.closeSession('draft');await new Promise<void>(r=>setImmediate(r));
    assert.equal(calls,1);release.resolve();await Promise.all([first,second]);assert.equal(h.raw[0]!.closes,1);
  }finally{release.resolve();await Promise.allSettled([first,second]);await h.cleanup();}
});
test('a terminal publication cannot await retirement of its own still-running event queue',async()=>{
  const h=await setup();try{h.onTerminal(async()=>{await assert.rejects(h.pool.closeSession('draft'),{code:'CONFLICT'});});
    await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');await h.finish(1);
    assert.equal(h.raw[0]!.closes,0);await h.pool.closeSession('draft');assert.equal(h.raw[0]!.closes,1);
  }finally{await h.cleanup();}
});
test('a foreign external session cannot inject stream output through a current turn id',async()=>{
  const h=await setup();try{await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');
    h.raw[0]!.options.onEvent({engineId:'codex',payload:{type:'delta',itemId:'foreign',content:'foreign output'},
      meta:{source:'realtime',sequence:99,observedAt:100,externalSessionId:'another-session',externalTurnId:'turn-1'}});
    await new Promise<void>(r=>setTimeout(r,20));assert.equal(h.runtimes.get('draft')!.currentContent,'');await h.finish(1);
  }finally{await h.cleanup();}
});
test('registry availability rejection before adapter connection must settle the accepted attempt',async()=>{
  const h=await setup();try{h.unavailable();await h.enqueue(1);await h.scheduler.drain(key);
    assert.equal(h.f.scalar("SELECT status FROM sessions WHERE id='draft'"),'failed');assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
    assert.equal(h.raw.length,0);assert.deepEqual(h.failedDispatches,[]);
  }finally{await h.cleanup();}
});
test('a committed result with failed publication does not permanently fence subsequent connection reuse',async()=>{
  const h=await setup();let first=true;try{h.onTerminal(async()=>{if(first){first=false;throw Error('synthetic publication failure');}});
    await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');h.raw[0]!.finish();
    await until(()=>h.failures.length===1);assert.equal(h.f.scalar("SELECT status FROM sessions WHERE id='draft'"),'completed');
    await h.enqueue(2);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-2');await h.finish(2);
    assert.equal(h.raw.length,1);assert.deepEqual(h.failedDispatches,[]);assert.equal(h.f.scalar('SELECT count(*) FROM engine_terminal_decisions'),2);
    await h.pool.closeSession('draft');
  }finally{await h.cleanup();}
});
test('failed compaction publication preserves the counter and allows subsequent output and terminal',async()=>{
  let failPublication=false,refreshes=0;
  const h=await setup(false,true,false,async()=>{if(failPublication){refreshes++;throw Error('synthetic publication failure');}});
  try{
    await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');
    failPublication=true;
    h.raw[0]!.emit({type:'system_notice',noticeType:'context_compaction',title:'compacted',contextCompaction:{threadId:'external',turnId:'turn-1'}},'turn-1');
    await h.pool.getBinding('draft')!.events.storage.drain();
    assert.equal(h.f.scalar("SELECT context_compaction_count FROM sessions WHERE id='draft'"),1);
    assert.equal(refreshes,1);
    h.raw[0]!.emit({type:'delta',itemId:'continued',phase:'final_answer',content:'after compaction'},'turn-1');
    await h.pool.getBinding('draft')!.events.storage.drain();
    assert.equal(h.runtimes.get('draft')!.finalAnswerContent,'after compaction');
    await h.finish(1);
    assert.equal(h.f.scalar("SELECT status FROM sessions WHERE id='draft'"),'completed');
    assert.deepEqual(h.failures,[]);
  }finally{await h.cleanup();}
});

test('an unconfirmed terminal write cannot use the committed-publication recovery path',async()=>{
  const h=await setup(),execute=h.port.execute.bind(h.port);
  h.port.execute=(async(request:any)=>request.command.name==='turn.finishFromFact'
    ?{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'}:execute(request)) as typeof h.port.execute;
  try{await h.enqueue(1);await h.scheduler.drain(key);await until(()=>h.runtimes.get('draft')?.currentTurnId==='turn-1');h.raw[0]!.finish();await until(()=>h.failures.length===1);
    assert.equal(h.pool.getBinding('draft')!.events.storage.isTerminalCommitted(),false);assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
    await assert.rejects(h.pool.closeSession('draft'),{code:'CONFLICT'});assert.equal(h.raw[0]!.closes,0);
  }finally{await h.cleanup();}
});
