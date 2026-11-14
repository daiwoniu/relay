import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,markRead } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StoredRuntimeGraph } from './stored-runtime-graph.js';
import { createStoredRuntimePreparation } from './stored-runtime-preparation.js';
import { EngineRegistry } from '../engine/registry.js';
import type { EngineAdapter,EngineConnectionOptions,EngineEvent } from '../engine/adapter.js';
import type { FrontendClient } from './frontend-client-hub.js';
import { hashSessionToken } from '../auth/session.js';
import { StoredFrontendCommands } from './stored-frontend-commands.js';
const until=async(check:()=>boolean)=>{for(let i=0;i<400&&!check();i++)await new Promise<void>(r=>setTimeout(r,5));assert.ok(check(),'Native graph stage timed out');};
test('composed Native graph authenticates, schedules, streams and saves two turns through a reused connection',async()=>{
  const f=fixture(),project=randomUUID(),session=randomUUID();
  const tokenHash=hashSessionToken('synthetic-graph');
  f.mutate(`DELETE FROM engine_resource_leases;INSERT INTO projects(id,owner_user_id,path) VALUES('${project}','owner','D:/synthetic-graph');INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${tokenHash}','owner',${Date.now()+600000})`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true,defaultConcurrency:{'codex:default':1}});
  const raw:Connection[]=[],messages:any[]=[],diagnostics:string[]=[];
  const hasProcessItem=(id:string,status:string)=>messages.some(event=>
    (['item_start','item_complete'].includes(event.type)&&event.item.id===id&&event.item.status===status)
    ||(['sync_state','runtime_sync_state'].includes(event.type)&&event.processSteps.some((item:any)=>item.id===id&&item.status===status)));
  class Connection{
    ready:Promise<void>;sequence=0;turn='';
    constructor(readonly options:EngineConnectionOptions){this.ready=Promise.resolve().then(async()=>{await options.onSessionReady('external');});}
    emit(payload:EngineEvent){this.options.onEvent({engineId:'codex',payload,meta:{source:'realtime',sequence:++this.sequence,observedAt:Date.now(),externalSessionId:'external',...('turnId' in payload?{externalTurnId:payload.turnId}:{})}});}
    send(content:string){void this.ready.then(()=>{this.turn=randomUUID();this.emit({type:'turn_start',turnId:this.turn});this.options.onInputAccepted?.(this.turn,content);
      this.emit({type:'delta',itemId:'text',phase:'final_answer',content:'answer'});});}
    finish(){this.emit({type:'message_complete',turnId:this.turn,content:'answer'});}
    steering=false;steerCalls=0;
    async steer(){if(!this.steering)return 'unsupported' as const;this.steerCalls++;return 'accepted' as const;}
    responses=0;cancel(){return Promise.resolve();}respondToInteraction(){this.responses++;}close(){this.options.onClosed();}
  }
  const registry=new EngineRegistry([{id:'codex',interactions:{normalize:(request:any)=>({id:'approval',requestId:request.requestId,kind:'command',snapshot:{title:'synthetic'},availableActions:['accept_once','decline'],autoApprovable:false}),buildResponse:(_request:any,command:any)=>({decision:command.action})},availability:{getCurrent:()=>({available:true})},runtime:{connect:(options:EngineConnectionOptions)=>{const connection=new Connection(options);raw.push(connection);return connection;}}} as unknown as EngineAdapter]);
  const graph=new StoredRuntimeGraph({port,storeId:'store',generation:1,registry,assertExclusiveWriter:async()=>{},collectFileChanges:async()=>({}),attachmentAvailability:()=>false,
    resolveResource:()=>({label:'Synthetic',defaultMaxActiveTurns:1}),diagnostic:code=>{diagnostics.push(code);},
    prepareRuntime:createStoredRuntimePreparation(async()=>({displayNames:{},modelDefaults:{test:{reasoningEffort:'high',serviceTier:'default'}},defaultModelId:'test'}))});
  async function enqueue(n:number){const result=await port.execute({...markRead(),operationId:`graph-enqueue-${n}`,command:{name:'turn.enqueue',input:{sessionId:session,attemptId:randomUUID(),messageId:randomUUID(),engineId:'codex',resourceKey:'codex:default',content:'question',metadata:null,expectedPreferencesRevision:0,origin:{kind:'direct'},...(n===1?{draft:{projectId:project,title:'Graph',titleManuallySet:false}}:{})}}});assert.equal(result.state,'committed');}
  try{
    await enqueue(1);const principal={kind:'user' as const,userId:'owner',authSessionHash:tokenHash};
    const auth=(await port.authenticateSession({tokenHash:principal.authSessionHash}))!;
    const client:FrontendClient={ws:{readyState:1,bufferedAmount:0,send:(data:string,callback:(error?:Error)=>void)=>{messages.push(JSON.parse(data));callback();},close:()=>{}} as any,
      actor:{userId:'owner',role:'member'},userId:'owner',user:auth.user,ip:'127.0.0.1',authTokenHash:principal.authSessionHash,authExpiresAt:auth.expiresAt,authExpiryTimer:null,
      activeSubscriptionSessionId:null,subscribedSessionIds:new Set()};
    assert.equal(await graph.sync.connect(client),true);assert.equal(await graph.sync.subscribe(client,session),true);
    for(let n=1;n<=2;n++){
      if(n===2)await enqueue(n);await graph.scheduler.drain('codex:default');
      await until(()=>graph.runtimes.get(session)?.finalAnswerContent==='answer');
      if(n===1){
        const messageId=randomUUID();
        await graph.followups.submit(principal,{sessionId:session,messageId,content:'queued followup',attachments:[],replyToAsyncQuestionId:null,origin:null});
        await until(()=>messages.some(event=>event.type==='session_followup_snapshot'&&event.followups.some((record:any)=>record.id===messageId&&record.state==='queued')));
        await graph.followups.cancel(principal,session,messageId);
        await until(()=>messages.some(event=>event.type==='session_followup_snapshot'&&event.followups.some((record:any)=>record.id===messageId&&record.state==='cancelled')));
        raw[0]!.steering=true;
        const acceptedId=randomUUID(),input={sessionId:session,messageId:acceptedId,content:'accepted while running',attachments:[],replyToAsyncQuestionId:null,origin:null};
        assert.equal((await graph.followups.submit(principal,input)).state,'steered');
        await until(()=>messages.some(event=>event.type==='message_saved'&&event.message.id===acceptedId));
        assert.ok(messages.some(event=>event.type==='message_saved'&&event.message.id===acceptedId&&event.message.role==='user'&&event.message.content===input.content),'accepted followup must reach the live message list without reconnect');
        assert.equal(graph.runtimes.get(session)?.isRunning,true,'accepted followup must not settle the active assistant turn');
        assert.equal((await graph.followups.submit(principal,input)).state,'steered');
        assert.equal(raw[0]!.steerCalls,1,'receipt replay must not steer again');
        assert.equal(messages.filter(event=>event.type==='message_saved'&&event.message.id===acceptedId).length,1,'receipt replay must not duplicate the live user message');
        const backgroundMessages:any[]=[];
        const otherDevice:FrontendClient={...client,ws:{readyState:1,bufferedAmount:0,send:(data:string,callback:(error?:Error)=>void)=>{backgroundMessages.push(JSON.parse(data));callback();},close:()=>{}} as any,
          subscribedSessionIds:new Set(),activeSubscriptionSessionId:null,authExpiryTimer:null};
        assert.equal(await graph.sync.connect(otherDevice),true);
        raw[0]!.emit({type:'item_complete',item:{id:'global-question',type:'agentMessage',delivery:'async',questions:[{title:'请选择下一步',options:['继续','稍后']}]}} as any);
        await until(()=>backgroundMessages.some(event=>event.type==='pending_approvals_snapshot'&&event.live&&event.approvals.some((item:any)=>item.id==='async-question:global-question')));
        assert.equal(otherDevice.subscribedSessionIds.size,0,'global question reminder must not require a conversation subscription');
        await graph.followups.submit(principal,{sessionId:session,messageId:randomUUID(),content:'继续',attachments:[],replyToAsyncQuestionId:'async-question:global-question',origin:null});
        await until(()=>backgroundMessages.filter(event=>event.type==='pending_approvals_snapshot').at(-1)?.approvals.length===0);
        await until(()=>messages.filter(event=>event.type==='pending_approvals_snapshot').at(-1)?.approvals.length===0);
        const closingQuestion={id:'close-global',type:'agentMessage',delivery:'async',questions:[{title:'May be closed'}]};
        raw[0]!.emit({type:'item_complete',item:closingQuestion} as any);
        await until(()=>backgroundMessages.some(event=>event.type==='pending_approvals_snapshot'&&event.approvals.some((item:any)=>item.id==='async-question:close-global')));
        const commands=new StoredFrontendCommands({port,storeId:'store',generation:1,graph,sender:undefined!,assertExclusiveWriter:async()=>{}});
        try{await commands.handle(client,{type:'respond_interaction',operationId:randomUUID(),sessionId:session,interactionId:'async-question:close-global',action:'cancel'});}
        finally{await commands.close();}
        for(const received of [messages,backgroundMessages])assert.ok(received.some(event=>event.type==='pending_approval_resolved'&&event.interactionId==='async-question:close-global'&&event.item?.details.resolvedAction==='cancel'));
        assert.equal(graph.runtimes.get(session)?.turnItems.find(item=>item.id==='async-question:close-global')?.status,'completed');
        raw[0]!.emit({type:'item_complete',item:closingQuestion} as any);
        await graph.connections.getBinding(session)!.events.storage.drain();
        assert.equal(graph.runtimes.get(session)?.turnItems.find(item=>item.id==='async-question:close-global')?.status,'completed','late provider duplicate must not reopen the question');
        graph.hub.remove(otherDevice);
      }
      if(n===1){
        const binding=graph.connections.getBinding(session)!;
        raw[0]!.emit({type:'item_start',item:{id:'compaction',type:'contextCompaction',status:'in_progress'}});
        await binding.events.storage.drain();
        assert.equal(f.scalar(`SELECT context_compaction_count FROM sessions WHERE id='${session}'`),0,'starting compaction must not count as completed');
        await until(()=>hasProcessItem('compaction','in_progress'));
        assert.ok(hasProcessItem('compaction','in_progress'),'compaction start must reach the live process list through stream or snapshot');
        const beforeUpdates=messages.filter(event=>event.type==='session_updated'&&event.sessionId===session).length;
        raw[0]!.emit({type:'item_complete',item:{id:'compaction',type:'contextCompaction',status:'completed'},threadId:'external',turnId:raw[0]!.turn});
        await binding.events.storage.drain();
        await until(()=>messages.filter(event=>event.type==='session_updated'&&event.sessionId===session).at(-1)?.session.context_compaction_count===1);
        assert.equal(messages.filter(event=>event.type==='session_updated'&&event.sessionId===session).at(-1)?.session.context_compaction_count,1,
          'completion item alone must update the live ring');
        raw[0]!.emit({type:'system_notice',noticeType:'context_compaction',title:'compacted',contextCompaction:{threadId:'external',turnId:raw[0]!.turn}});
        await binding.events.storage.drain();
        assert.equal(f.scalar(`SELECT context_compaction_count FROM sessions WHERE id='${session}'`),1,'completion and notification must count compaction once');
        assert.equal(messages.filter(event=>event.type==='session_updated'&&event.sessionId===session).at(-1)?.session.context_compaction_count,1,
          'completed compaction must update the live context ring before the turn finishes or reconnects');
        assert.equal(messages.filter(event=>event.type==='session_updated'&&event.sessionId===session).length,beforeUpdates+1,
          'the duplicate completion notice must not refresh session state again');
        await until(()=>hasProcessItem('compaction','completed'));
        raw[0]!.emit({type:'delta',itemId:'after-compaction',phase:'final_answer',content:' continued'});
        await binding.events.storage.drain();
        assert.equal(graph.runtimes.get(session)?.finalAnswerContent,'answer continued');
      }
      if(n===2){
        raw[0]!.emit({type:'system_notice',noticeType:'context_compaction',title:'compacted',contextCompaction:{threadId:'external',turnId:raw[0]!.turn}});
        await graph.connections.getBinding(session)!.events.storage.drain();
        await until(()=>messages.filter(event=>event.type==='session_updated'&&event.sessionId===session).at(-1)?.session.context_compaction_count===2);
        assert.equal(messages.filter(event=>event.type==='session_updated'&&event.sessionId===session).at(-1)?.session.context_compaction_count,2,
          'completion notice alone must update the live ring for a later turn');
      }
      raw[0]!.finish();
      await until(()=>!graph.runtimes.get(session)?.isRunning);
      await until(()=>messages.filter(event=>event.type==='message_saved'&&event.message.role==='assistant').length===n);
    }
    assert.equal(raw.length,1);assert.equal(f.scalar(`SELECT count(*) FROM messages WHERE session_id='${session}' AND role='assistant'`),2);
    assert.ok(messages.some(event=>event.type==='delta'));assert.equal(messages.filter(event=>event.type==='message_saved'&&event.message.role==='assistant').length,2);
    raw[0]!.emit({type:'server_request',requestId:99,method:'execCommandApproval',params:{}});
    await until(()=>messages.some(event=>event.type==='pending_approvals_snapshot'&&event.approvals.length===1));
    assert.equal(await graph.sync.subscribe(client,session),true);
    const interactionId=[...graph.runtimes.get(session)!.pendingInteractions.keys()][0]!;
    const command={type:'respond_interaction' as const,operationId:randomUUID(),sessionId:session,interactionId,action:'accept' as const};
    assert.deepEqual(await graph.responses.respond(principal,command),{state:'submitted',projectionPending:false});
    assert.deepEqual(await graph.responses.respond(principal,command),{state:'submitted',projectionPending:false});
    assert.equal(raw[0]!.responses,1);assert.equal(f.scalar(`SELECT count(*) FROM messages WHERE session_id='${session}' AND phase='interaction'`),1);
    assert.equal(f.scalar(`SELECT status FROM sessions WHERE id='${session}'`),'completed');
    assert.equal(graph.runtimes.get(session)!.isRunning,false);
    assert.deepEqual(diagnostics,[]);
    await enqueue(3);await graph.scheduler.drain('codex:default');
    await until(()=>graph.runtimes.get(session)?.finalAnswerContent==='answer');
    const running=graph.runtimes.get(session)!;
    assert.deepEqual(await graph.stop.request(principal,{sessionId:session,expectedAttemptId:running.attemptId!},'graph-running-stop'),{state:'requested',confirmed:true});
    assert.equal(f.scalar(`SELECT status FROM sessions WHERE id='${session}'`),'stopped');
    assert.equal(f.scalar(`SELECT count(*) FROM messages WHERE session_id='${session}' AND role='assistant' AND stopped=1`),1);
    assert.equal(f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
  }finally{try{await graph.close();}catch{/* Keep the original assertion visible; worker cleanup is unconditional. */}finally{await port.close();f.cleanup();}}
});

test('frontend cancellation during model preparation settles stopped without starting an engine or keeping the queue lease',async()=>{
  const f=fixture(),session=randomUUID(),attempt=randomUUID();
  const authHash=hashSessionToken('synthetic-preparation-cancel');
  f.mutate(`DELETE FROM engine_resource_leases;INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${authHash}','owner',${Date.now()+600000})`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true,defaultConcurrency:{'codex:default':1}});
  let entered=false,release!:()=>void,connects=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const registry=new EngineRegistry([{id:'codex',runtime:{connect:()=>{connects++;throw Error('cancelled turn must never connect');}}} as unknown as EngineAdapter]);
  const graph=new StoredRuntimeGraph({port,storeId:'store',generation:1,registry,assertExclusiveWriter:async()=>{},
    collectFileChanges:async()=>({}),attachmentAvailability:()=>false,resolveResource:()=>({label:'Synthetic',defaultMaxActiveTurns:1}),diagnostic:()=>{},
    prepareRuntime:createStoredRuntimePreparation(async()=>{
      entered=true;await gate;return{displayNames:{},modelDefaults:{},defaultModelId:null};
    })});
  const commands=new StoredFrontendCommands({port,storeId:'store',generation:1,graph,sender:undefined!,assertExclusiveWriter:async()=>{}});
  let draining:Promise<unknown>|undefined;
  try{
    const queued=await port.execute({...markRead(),operationId:'prepare-cancel-enqueue',command:{name:'turn.enqueue',input:{
      sessionId:session,attemptId:attempt,messageId:randomUUID(),engineId:'codex',resourceKey:'codex:default',content:'保留取消前的用户消息',metadata:null,
      expectedPreferencesRevision:0,origin:{kind:'direct'},draft:{projectId:'project',title:'Preparing cancel',titleManuallySet:false}}}});
    assert.equal(queued.state,'committed');draining=graph.scheduler.drain('codex:default');await until(()=>entered);
    await assert.rejects(commands.handle({userId:'owner',authTokenHash:authHash,ws:{readyState:1}} as FrontendClient,{type:'cancel',sessionId:session}),{code:'STORAGE_UNAVAILABLE'});
    assert.equal(f.scalar(`SELECT status FROM sessions WHERE id='${session}'`),'stopping');
    release();await draining;
    assert.equal(f.scalar(`SELECT status FROM sessions WHERE id='${session}'`),'stopped');
    assert.equal(f.scalar(`SELECT count(*) FROM messages WHERE session_id='${session}' AND role='user'`),1);
    assert.equal(f.scalar(`SELECT count(*) FROM messages WHERE session_id='${session}' AND role='assistant' AND stopped=1`),1);
    assert.equal(f.scalar('SELECT count(*) FROM engine_resource_leases'),0);assert.equal(connects,0);
  }finally{release();await draining?.catch(()=>undefined);await commands.close();try{await graph.suspend();}finally{await port.close();f.cleanup();}}
});
