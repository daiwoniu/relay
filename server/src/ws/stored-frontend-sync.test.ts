import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StoredFrontendHub } from './stored-frontend-hub.js';
import { StoredFrontendSync } from './stored-frontend-sync.js';
import { createSessionRuntimeState, type SessionRuntime } from '../engine/runtime.js';
import type { FrontendClient } from './frontend-client-hub.js';
import { hashSessionToken } from '../auth/session.js';
import { presentProcessItem } from '../messages/presenter.js';
const session='22222222-2222-4222-8222-222222222222',project='11111111-1111-4111-8111-111111111111';
const principal=(id='owner')=>({kind:'user' as const,userId:id,authSessionHash:hashSessionToken(`synthetic-sync-${id}`)});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>((r)=>{resolve=r;});return{promise,resolve};}
class Socket{
  readyState=1;bufferedAmount=0;messages:any[]=[];closes:any[]=[];onSend:((event:any)=>void)|undefined;
  send(data:string,callback:(error?:Error)=>void){const event=JSON.parse(data);this.messages.push(event);this.onSend?.(event);callback();}
  close(code:number,reason:string){this.closes.push({code,reason});this.readyState=3;}
}
async function prepared(){
  const f=fixture();f.mutate(`INSERT INTO projects(id,owner_user_id,path) VALUES('${project}','owner','D:/sync-synthetic');
    INSERT INTO sessions(id,owner_user_id,project_id,status,engine,engine_bound,message_revision,updated_at,codex_thread_id)
      VALUES('${session}','owner','${project}','completed','codex',1,2,100,'thread');
    INSERT INTO messages(id,session_id,turn_id,role,content,phase,created_at,stopped) VALUES('sync-user','${session}','turn','user','question',NULL,10,0),
      ('sync-answer','${session}','turn','assistant','answer','final_answer',20,0);
    INSERT INTO session_read_receipts VALUES('owner','${session}','sync-answer',30);
    INSERT INTO session_followups(id,session_id,user_id,content,state,created_at,updated_at) VALUES('followup','${session}','owner','private followup','paused',40,40);
    INSERT INTO project_members VALUES('${project}','other','viewer',1,1,1)`);
  for(const id of ['owner','other','admin'])f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${principal(id).authSessionHash}','${id}',${Date.now()+600_000})`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const hub=new StoredFrontendHub(port),runtimes=new Map<string,SessionRuntime>();
  const sync=new StoredFrontendSync({hub,port,runtimes,resolveResource:(key)=>key==='codex:default'?{label:'Codex',defaultMaxActiveTurns:2}:null});
  async function client(id='owner'){
    const auth=(await port.authenticateSession({tokenHash:principal(id).authSessionHash}))!,socket=new Socket();
    const c:FrontendClient={ws:socket as any,actor:{userId:id,role:auth.user.role},userId:id,user:auth.user,ip:'127.0.0.1',authTokenHash:principal(id).authSessionHash,
      authExpiresAt:auth.expiresAt,authExpiryTimer:null,subscribedSessionIds:new Set(),activeSubscriptionSessionId:null};return {c,socket};
  }
  function running(){
    f.mutate(`UPDATE sessions SET status='processing',active_attempt_id='live-attempt' WHERE id='${session}'`);
    const runtime=createSessionRuntimeState({sessionId:session,projectId:project,engine:'codex'});runtime.attemptId='live-attempt';runtime.engineConnectionId='live-connection';runtime.isRunning=true;runtime.currentContent='A';
    runtime.engineConnection={send(){},cancel:async()=>{},respondToInteraction:async()=>{},close(){}};
    runtimes.set(session,runtime);return runtime;
  }
  function pauseRead(){const entered=deferred(),release=deferred(),original=port.readSessionSync.bind(port);let once=true,calls=0;
    port.readSessionSync=async(request)=>{calls++;const value=await original(request);if(once){once=false;entered.resolve();await release.promise;}return value;};
    return {entered,release,calls:()=>calls};
  }
  return {f,port,hub,runtimes,sync,client,running,pauseRead,cleanup:async()=>{hub.dispose();await port.close();f.cleanup();}};
}
test('large generated images survive full sync, manual resync and runtime-only refresh without binary transport',async()=>{
  const p=await prepared();try{
    const runtime=p.running();
    const bytes='A'.repeat(4*1024*1024);
    runtime.turnItems=Array.from({length:3},(_,n)=>({id:`image-${n}`,type:'imageGeneration',status:'completed',result:bytes,savedPath:`image-${n}.png`,prompt:`design ${n}`}));
    const original=runtime.turnItems;
    for(const reconnect of [false,true]){
      const a=await p.client();assert.equal(await p.sync.connect(a.c),true);
      for(const includeMessages of [true,true,false]){
        a.socket.messages=[];
        assert.equal(await p.sync.subscribe(a.c,session,true,includeMessages),true);
        const state=a.socket.messages.find(m=>m.type===(includeMessages?'sync_state':'runtime_sync_state'));
        assert.equal(state.isRunning,true);assert.equal(state.processSteps.length,3);
        assert.equal(state.processSteps[0].details.prompt,'design 0');
        assert.ok(Buffer.byteLength(JSON.stringify(a.socket.messages))<32*1024);
        assert.equal(a.c.subscribedSessionIds.has(session),true);
        const update=await p.hub.broadcastSession({type:'item_complete',sessionId:session,item:presentProcessItem(runtime.turnItems[0])!});
        assert.equal(update.sent,1);
        assert.ok(Buffer.byteLength(JSON.stringify(a.socket.messages))<32*1024);
      }
      if(!reconnect)p.hub.remove(a.c);
    }
    assert.equal(runtime.turnItems,original);
    assert.equal(runtime.turnItems[0].result,bytes);
  }finally{await p.cleanup();}
});

test('initial connection and reconnect restore receipts, terminal state, messages and owner followups without writes',async()=>{
  const p=await prepared();try{
    const first=await p.client();assert.equal(await p.sync.connect(first.c),true);
    assert.deepEqual(first.socket.messages.map((m)=>m.type),['protocol_info','session_reads','pending_approvals_snapshot']);
    assert.equal(first.socket.messages[1].receipts[session],'sync-answer');
    assert.equal(await p.sync.subscribe(first.c,session),true);
    const state=first.socket.messages.find((m)=>m.type==='sync_state');assert.equal(state.messageRevision,2);assert.equal(state.messages.at(-1).content,'answer');
    assert.equal(first.socket.messages.find((m)=>m.type==='session_updated').snapshot,true);
    assert.equal(first.socket.messages.find((m)=>m.type==='session_updated').session.status,'completed');
    assert.equal(first.socket.messages.find((m)=>m.type==='session_followup_snapshot').followups[0].content,'private followup');
    p.hub.remove(first.c);const next=await p.client();await p.sync.connect(next.c);await p.sync.subscribe(next.c,session);
    assert.equal(next.socket.messages.find((m)=>m.type==='sync_state').messages.length,2);
    assert.equal(p.f.scalar(`SELECT status FROM sessions WHERE id='${session}'`),'completed');assert.equal(p.f.scalar(`SELECT updated_at FROM sessions WHERE id='${session}'`),100);
    assert.equal(p.f.scalar(`SELECT message_revision FROM sessions WHERE id='${session}'`),2);assert.equal(p.f.scalar(`SELECT message_id FROM session_read_receipts WHERE session_id='${session}'`),'sync-answer');
  }finally{await p.cleanup();}
});

test('followup attachments survive subscription, runtime refresh and reconnect for the owner',async()=>{
  const p=await prepared();try{
    const attachments=[
      {id:randomUUID(),kind:'uploaded_file',name:'photo.png',path:'D:/sync-synthetic/photo.png',size:123,mimeType:'image/png',available:true},
      {id:randomUUID(),kind:'host_file',name:'notes.txt',path:'D:/sync-synthetic/notes.txt',size:45},
    ];
    p.f.mutate(`UPDATE session_followups SET attachments_json='${JSON.stringify(attachments)}' WHERE id='followup'`);
    for(const runtimeOnly of [false,true,false]){
      const a=await p.client();await p.sync.connect(a.c);await p.sync.subscribe(a.c,session,true,!runtimeOnly);
      assert.deepEqual(a.socket.messages.find(m=>m.type==='session_followup_snapshot').followups[0].attachments,attachments);
      p.hub.remove(a.c);
    }
    const other=await p.client('other');await p.sync.connect(other.c);await p.sync.subscribe(other.c,session);
    assert.equal(other.socket.messages.some(m=>m.type==='session_followup_snapshot'),false);
  }finally{await p.cleanup();}
});

test('runtime-only followup refresh preserves a queued saved message publication without reconnect',async()=>{
  const p=await prepared();try{
    const a=await p.client();await p.sync.connect(a.c);await p.sync.subscribe(a.c,session);
    p.running();a.socket.messages=[];
    const id=randomUUID();
    const saved=p.hub.broadcastMessage({revision:3,savedMessage:{id,sessionId:session,turnId:'live-turn',role:'user',content:'additional input',phase:null,
      items:null,metadata:null,createdAt:101,durationMs:null,stopped:false}},
      {readSession:p.port.readSession.bind(p.port),attachmentAvailability:()=>false,isCurrent:()=>true});
    // Accepted followups publish their saved message and then refresh runtime/followup state.
    // The refresh does not include message history, so it must not discard that publication.
    const refreshed=p.sync.subscribe(a.c,session,true,false);
    assert.equal(await refreshed,true);assert.equal((await saved).sent,1);
    const messages=a.socket.messages.filter(m=>m.type==='message_saved'&&m.message.id===id);
    assert.equal(messages.length,1);assert.equal(messages[0].message.content,'additional input');
    assert.equal(a.socket.messages.some(m=>m.type==='runtime_sync_state'&&m.isRunning),true);
    assert.equal(a.socket.messages.some(m=>m.type==='sync_state'),false);
  }finally{await p.cleanup();}
});

test('overlapping runtime refreshes preserve saved messages for active and background subscribers',async()=>{
  const p=await prepared();try{
    p.running();const active=await p.client(),background=await p.client();
    for(const [a,isActive] of [[active,true],[background,false]] as const){await p.sync.connect(a.c);await p.sync.subscribe(a.c,session,isActive);a.socket.messages=[];}
    const id=randomUUID();
    const saved=p.hub.broadcastMessage({revision:3,savedMessage:{id,sessionId:session,turnId:'live-turn',role:'user',content:'multi-device input',phase:null,
      items:null,metadata:null,createdAt:101,durationMs:null,stopped:false}},
      {readSession:p.port.readSession.bind(p.port),attachmentAvailability:()=>false,isCurrent:()=>true});
    const refreshes=[active,background].flatMap(a=>[1,2].map(()=>p.sync.subscribe(a.c,session,a===active,false)));
    assert.equal((await saved).sent,2);assert.deepEqual(await Promise.all(refreshes),[true,true,true,true]);
    for(const a of [active,background])assert.equal(a.socket.messages.filter(m=>m.type==='message_saved'&&m.message.id===id).length,1);
    assert.equal(active.c.activeSubscriptionSessionId,session);assert.equal(background.c.activeSubscriptionSessionId,null);
  }finally{await p.cleanup();}
});

test('saved messages arriving during a runtime refresh survive its snapshot retry',async()=>{
  const p=await prepared();let release:(()=>void)|undefined;try{
    p.running();const a=await p.client();await p.sync.connect(a.c);await p.sync.subscribe(a.c,session);a.socket.messages=[];
    const gate=p.pauseRead();release=gate.release.resolve;
    const refresh=p.sync.subscribe(a.c,session,true,false);await gate.entered.promise;
    const id=randomUUID();
    const saved=p.hub.broadcastMessage({revision:3,savedMessage:{id,sessionId:session,turnId:'live-turn',role:'assistant',content:'committed result',phase:'final_answer',
      items:null,metadata:'{"outcome":"completed"}',createdAt:101,durationMs:1,stopped:false}},
      {readSession:p.port.readSession.bind(p.port),attachmentAvailability:()=>false,isCurrent:()=>true});
    gate.release.resolve();
    assert.equal(await refresh,true);assert.equal((await saved).sent,1);assert.ok(gate.calls()>=2);
    assert.equal(a.socket.messages.filter(m=>m.type==='message_saved'&&m.message.id===id).length,1);
  }finally{release?.();await p.cleanup();}
});

test('explicit unsubscribe still invalidates saved messages queued on the former subscription',async()=>{
  const p=await prepared();try{
    const a=await p.client();await p.sync.connect(a.c);await p.sync.subscribe(a.c,session);a.socket.messages=[];
    const saved=p.hub.broadcastMessage({revision:3,savedMessage:{id:randomUUID(),sessionId:session,turnId:'old-turn',role:'user',content:'old subscription input',phase:null,
      items:null,metadata:null,createdAt:101,durationMs:null,stopped:false}},
      {readSession:p.port.readSession.bind(p.port),attachmentAvailability:()=>false,isCurrent:()=>true});
    p.hub.unsubscribe(a.c,session);
    assert.equal(await p.sync.subscribe(a.c,session,false,false),true);assert.equal((await saved).sent,0);
    assert.equal(a.socket.messages.some(m=>m.type==='message_saved'),false);
    assert.equal(a.c.activeSubscriptionSessionId,null);
  }finally{await p.cleanup();}
});

test('durable unanswered questions restore globally without a runtime and clear across devices after an answer claim',async()=>{
  const p=await prepared();try{
    const item={id:'async-question:global',type:'interaction',status:'in_progress',details:{interactionKind:'async_question',questions:[{title:'请选择方案'}]}};
    p.f.mutate(`INSERT INTO _relay_async_questions VALUES('${session}','${item.id}','past-attempt','past-turn','${JSON.stringify(item)}','synthetic',NULL,50)`);
    const owner=await p.client(),otherDevice=await p.client(),viewer=await p.client('other'),admin=await p.client('admin');admin.c.resourceScope='all';
    for(const a of [owner,otherDevice,viewer,admin])await p.sync.connect(a.c);
    for(const a of [owner,otherDevice]){
      const snapshot=a.socket.messages.find(m=>m.type==='pending_approvals_snapshot');
      assert.equal(snapshot.approvals[0].kind,'async_question');assert.equal(snapshot.live,undefined);
      assert.equal(a.c.subscribedSessionIds.size,0,'无需订阅或打开该会话');
    }
    for(const a of [viewer,admin])assert.deepEqual(a.socket.messages.find(m=>m.type==='pending_approvals_snapshot').approvals,[],'异步回答严格限定会话所有者');
    const claimed=await p.port.execute({protocolVersion:1,storeId:'store',workerGeneration:1,requestId:randomUUID(),operationId:'answer-global',principal:principal(),
      command:{name:'followup.submit',input:{sessionId:session,messageId:'answer-global',content:'方案A',attachments:[],replyToAsyncQuestionId:item.id,origin:null}}});
    assert.equal(claimed.state,'committed');
    for(const a of [owner,otherDevice]){await p.sync.refresh(a.c,true);assert.deepEqual(a.socket.messages.at(-1),{type:'pending_approvals_snapshot',approvals:[],live:true});}
    p.f.mutate(`UPDATE _relay_async_questions SET answer_message_id=NULL WHERE session_id='${session}';UPDATE sessions SET deleted_at=100 WHERE id='${session}'`);
    await p.sync.refresh(owner.c,true);assert.deepEqual(owner.socket.messages.at(-1).approvals,[],'删除会话不保留提问提醒');
  }finally{await p.cleanup();}
});

test('ordinary questions enter live snapshots independently of automatic approval settings',async()=>{
  const p=await prepared();try{
    const a=await p.client();await p.sync.connect(a.c);
    const runtime=p.running();
    runtime.turnItems=[{id:'question',type:'interaction',status:'in_progress',details:{interactionKind:'user_input',questions:[{id:'q',question:'确认需求？'}]}}];
    runtime.pendingInteractions.set('question',{createdAt:2,connectionId:'live-connection',interaction:{kind:'user_input'}} as any);
    p.f.mutate(`INSERT INTO approval_trust_settings VALUES('trust-global','owner',NULL,'${session}','trusted',${Date.now()+600000},1,1)`);
    await p.sync.refresh(a.c,true);
    const event=a.socket.messages.at(-1);assert.equal(event.live,true);assert.equal(event.approvals[0].kind,'user_input');assert.deepEqual(event.approvals[0].availableActions,[]);
    runtime.pendingInteractions.clear();await p.sync.refresh(a.c,true);assert.deepEqual(a.socket.messages.at(-1).approvals,[]);
  }finally{await p.cleanup();}
});
test('snapshot absorbs deltas accepted during loading and preserves deltas emitted after the capture cut',async()=>{
  const p=await prepared();const waits:Promise<unknown>[]=[];try{
    const runtime=p.running(),a=await p.client();await p.sync.connect(a.c);a.socket.messages=[];
    const gate=p.pauseRead(),work=p.sync.subscribe(a.c,session);await gate.entered.promise;
    runtime.currentContent='AB';waits.push(p.hub.broadcastSession({type:'delta',sessionId:session,itemId:'text',content:'B'}));
    let injected=false;a.socket.onSend=(event)=>{if(event.type==='sync_state'&&!injected){injected=true;runtime.currentContent='ABC';waits.push(p.hub.broadcastSession({type:'delta',sessionId:session,itemId:'text',content:'C'}));}};
    gate.release.resolve();assert.equal(await work,true);await Promise.all(waits);
    assert.equal(a.socket.messages.find((m)=>m.type==='sync_state').currentContent,'AB');
    assert.deepEqual(a.socket.messages.filter((m)=>m.type==='delta').map((m)=>m.content),['C']);
  }finally{await Promise.allSettled(waits);await p.cleanup();}
});
test('durable updates arriving during a query force a fresh snapshot before queued live events',async()=>{
  const p=await prepared();try{
    const a=await p.client();await p.sync.connect(a.c);a.socket.messages=[];const gate=p.pauseRead(),work=p.sync.subscribe(a.c,session);await gate.entered.promise;
    p.f.mutate(`UPDATE messages SET content='new answer' WHERE id='sync-answer';UPDATE sessions SET message_revision=3 WHERE id='${session}'`);
    const current=(await p.port.readSession({principal:principal(),sessionId:session}))!;
    const update=p.hub.broadcastSession({type:'session_updated',sessionId:session,session:current});gate.release.resolve();
    assert.equal(await work,true);await update;assert.ok(gate.calls()>=2);
    const states=a.socket.messages.filter((m)=>m.type==='sync_state');assert.equal(states.length,1);assert.equal(states[0].messageRevision,3);assert.equal(states[0].messages.at(-1).content,'new answer');
  }finally{await p.cleanup();}
});
test('shared viewer revoked during loading gets no private snapshot and remains logged in',async()=>{
  const p=await prepared();try{
    const a=await p.client('other');await p.sync.connect(a.c);a.socket.messages=[];const gate=p.pauseRead(),work=p.sync.subscribe(a.c,session);await gate.entered.promise;
    p.f.mutate(`DELETE FROM project_members WHERE project_id='${project}' AND user_id='other'`);gate.release.resolve();assert.equal(await work,false);
    assert.equal(a.socket.messages.some((m)=>m.type==='sync_state'||m.type==='session_followup_snapshot'),false);
    assert.equal(a.socket.messages.at(-1).code,'SESSION_NOT_FOUND');assert.equal(a.socket.closes.length,0);assert.equal(a.c.subscribedSessionIds.size,0);
  }finally{await p.cleanup();}
});
test('a replacement socket cannot receive the old connection snapshot after a delayed query returns',async()=>{
  const p=await prepared();try{
    const a=await p.client();await p.sync.connect(a.c);a.socket.messages=[];const gate=p.pauseRead(),old=p.sync.subscribe(a.c,session);await gate.entered.promise;
    p.hub.remove(a.c);const b=await p.client();await p.sync.connect(b.c);assert.equal(await p.sync.subscribe(b.c,session),true);
    gate.release.resolve();assert.equal(await old,false);assert.equal(a.socket.messages.length,0);assert.equal(b.socket.messages.some((m)=>m.type==='sync_state'),true);
  }finally{await p.cleanup();}
});
test('unsubscribe and resubscribe invalidate delayed subscription intents; background subscriptions send runtime only',async()=>{
  const p=await prepared();try{
    const a=await p.client();await p.sync.connect(a.c);a.socket.messages=[];const gate=p.pauseRead(),old=p.sync.subscribe(a.c,session);await gate.entered.promise;
    p.hub.unsubscribe(a.c,session);const next=p.sync.subscribe(a.c,session,false);gate.release.resolve();assert.equal(await old,false);assert.equal(await next,true);
    assert.equal(a.socket.messages.filter((m)=>m.type==='sync_state').length,0);assert.equal(a.socket.messages.filter((m)=>m.type==='runtime_sync_state').length,1);assert.equal(a.c.activeSubscriptionSessionId,null);
  }finally{await p.cleanup();}
});
test('query failure never becomes an empty history or a logout',async()=>{
  const p=await prepared();try{
    const a=await p.client();await p.sync.connect(a.c);a.socket.messages=[];p.port.readSessionSync=async()=>{throw new Error('synthetic storage unavailable');};
    await assert.rejects(p.sync.subscribe(a.c,session),/synthetic storage unavailable/);
    assert.equal(a.socket.messages.length,0);assert.equal(a.socket.closes.length,0);assert.equal(a.c.subscribedSessionIds.size,0);
  }finally{await p.cleanup();}
});
test('auth is rechecked between snapshot frames, so logout after the first frame suppresses history',async()=>{
  const p=await prepared();try{
    const a=await p.client();await p.sync.connect(a.c);a.socket.messages=[];a.socket.onSend=(event)=>{if(event.type==='session_updated')p.f.mutate(`DELETE FROM auth_sessions WHERE token_hash='${principal().authSessionHash}'`);};
    assert.equal(await p.sync.subscribe(a.c,session),false);assert.equal(a.socket.messages.some((m)=>m.type==='sync_state'),false);assert.equal(a.socket.closes[0].code,1008);
  }finally{await p.cleanup();}
});
test('runtime replacement during sending rebuilds the snapshot instead of publishing old turn state',async()=>{
  const p=await prepared();try{
    p.running();const a=await p.client();await p.sync.connect(a.c);a.socket.messages=[];let replaced=false;
    a.socket.onSend=(event)=>{if(event.type==='session_updated'&&!replaced){replaced=true;p.f.mutate(`UPDATE sessions SET active_attempt_id='new-attempt' WHERE id='${session}'`);
      const next=p.running();next.attemptId='new-attempt';next.currentContent='new runtime';p.f.mutate(`UPDATE sessions SET active_attempt_id='new-attempt' WHERE id='${session}'`);}};
    assert.equal(await p.sync.subscribe(a.c,session),true);const states=a.socket.messages.filter((m)=>m.type==='sync_state');assert.equal(states.length,1);assert.equal(states[0].currentContent,'new runtime');
    assert.equal(a.socket.messages.filter(m=>m.type==='session_updated').at(-1)?.session.active_attempt_id,'new-attempt');
  }finally{await p.cleanup();}
});
test('pending approvals use current management authority rather than shared-view permission',async()=>{
  const p=await prepared();try{
    const runtime=p.running();runtime.turnItems=[{id:'approval',type:'interaction',status:'in_progress',details:{interactionKind:'command_approval',command:'echo synthetic'}}];
    runtime.pendingInteractions.set('approval',{createdAt:1,connectionId:'live-connection',interaction:{kind:'command_approval'}} as any);
    const owner=await p.client(),viewer=await p.client('other'),admin=await p.client('admin');admin.c.resourceScope='all';
    for(const a of [owner,viewer,admin])await p.sync.connect(a.c);
    assert.equal(owner.socket.messages.find((m)=>m.type==='pending_approvals_snapshot').approvals.length,1);
    assert.equal(viewer.socket.messages.find((m)=>m.type==='pending_approvals_snapshot').approvals.length,0);
    assert.equal(admin.socket.messages.find((m)=>m.type==='pending_approvals_snapshot').approvals.length,1);
    await p.sync.subscribe(viewer.c,session);assert.equal(viewer.socket.messages.some((m)=>m.type==='session_followup_snapshot'),false);
  }finally{await p.cleanup();}
});
test('admin downgrade during initialization cannot deliver a previously loaded all-scope approval snapshot',async()=>{
  const p=await prepared();try{
    const runtime=p.running();runtime.turnItems=[{id:'approval',type:'interaction',status:'in_progress',details:{interactionKind:'command_approval',command:'private command'}}];
    runtime.pendingInteractions.set('approval',{createdAt:1,connectionId:'live-connection',interaction:{kind:'command_approval'}} as any);
    const a=await p.client('admin');a.c.resourceScope='all';const entered=deferred(),release=deferred(),original=p.port.readFrontendSync.bind(p.port);let once=true;
    p.port.readFrontendSync=async(request)=>{const value=await original(request);if(once){once=false;entered.resolve();await release.promise;}return value;};
    const work=p.sync.connect(a.c);await entered.promise;p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");release.resolve();
    await assert.rejects(work,{code:'FORBIDDEN'});assert.equal(a.socket.messages.some((m)=>m.type==='pending_approvals_snapshot'),false);assert.equal(a.socket.closes.length,0);
  }finally{await p.cleanup();}
});
test('approval resolution between initialization frames causes a fresh snapshot without resurrecting a request',async()=>{
  const p=await prepared();try{
    const runtime=p.running();runtime.turnItems=[{id:'approval',type:'interaction',status:'in_progress',details:{interactionKind:'command_approval',command:'synthetic'}}];
    runtime.pendingInteractions.set('approval',{createdAt:1,connectionId:'live-connection',interaction:{kind:'command_approval'}} as any);
    const a=await p.client();let resolved=false;a.socket.onSend=(event)=>{if(event.type==='protocol_info'&&!resolved){resolved=true;runtime.pendingInteractions.clear();}};
    assert.equal(await p.sync.connect(a.c),true);
    const snapshots=a.socket.messages.filter((m)=>m.type==='pending_approvals_snapshot');assert.equal(snapshots.length,1);assert.deepEqual(snapshots[0].approvals,[]);
  }finally{await p.cleanup();}
});
test('a durable active attempt without a reconciled runtime fails synchronization instead of fabricating idle state',async()=>{
  const p=await prepared();try{
    p.f.mutate(`UPDATE sessions SET active_attempt_id='missing-runtime',status='processing' WHERE id='${session}'`);
    const a=await p.client();await p.sync.connect(a.c);a.socket.messages=[];
    await assert.rejects(p.sync.subscribe(a.c,session),/FRONTEND_SNAPSHOT_STALE/);
    assert.equal(a.socket.messages.some((m)=>m.type==='sync_state'||m.type==='runtime_sync_state'),false);
    assert.equal(p.f.scalar(`SELECT status FROM sessions WHERE id='${session}'`),'processing');
  }finally{await p.cleanup();}
});
test('queued state and queue position are restored without claiming or starting an engine',async()=>{
  const p=await prepared();try{
    const operationId=randomUUID(),attemptId=randomUUID();
    const result=await p.port.execute({protocolVersion:1,storeId:'store',workerGeneration:1,requestId:operationId,operationId,principal:principal(),command:{name:'turn.enqueue',input:{
      sessionId:session,attemptId,messageId:randomUUID(),engineId:'codex',resourceKey:'codex:default',content:'queued input',metadata:null,expectedPreferencesRevision:0,origin:{kind:'direct'}}}});
    assert.equal(result.state,'committed');const a=await p.client();await p.sync.connect(a.c);await p.sync.subscribe(a.c,session);
    const state=a.socket.messages.find((m)=>m.type==='sync_state');assert.equal(state.isRunning,false);assert.equal(state.queue.state,'queued');assert.equal(state.queue.position,1);assert.equal(state.queue.maxActiveTurns,2);
    assert.equal(p.f.scalar(`SELECT status FROM sessions WHERE id='${session}'`),'queued');assert.equal(p.f.scalar(`SELECT count(*) FROM engine_resource_leases WHERE session_id='${session}'`),0);
  }finally{await p.cleanup();}
});

test('native initialization guards scope, duplicate runtime IDs, disabled accounts and private followup budgets',async()=>{
  const p=await prepared();try{
    const input={principal:principal(),runtimeSessionIds:[session],scope:'mine' as const,activeSessionId:session};
    await assert.rejects(p.port.readFrontendSync({...input,scope:'all'}),{code:'FORBIDDEN'});
    await assert.rejects(p.port.readFrontendSync({...input,runtimeSessionIds:[session,session]}),{code:'INVALID_ARGUMENT'});
    await assert.rejects(p.port.readFrontendSync({...input,runtimeSessionIds:Array.from({length:513},()=>randomUUID())}),{code:'INVALID_ARGUMENT'});
    p.f.mutate("UPDATE session_followups SET content=CAST(zeroblob(1048577) AS TEXT) WHERE id='followup'");
    await assert.rejects(p.port.readSessionSync({principal:principal(),sessionId:session,includeMessages:true}),{code:'PAYLOAD_TOO_LARGE'});
    assert.equal((await p.port.readSessionSync({principal:principal('other'),sessionId:session,includeMessages:true})).followups,null);
    p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='other'");
    await assert.rejects(p.port.readFrontendSync({...input,principal:principal('other')}),{code:'FORBIDDEN'});
  }finally{await p.cleanup();}
});

test('session snapshot uses the file probe outside the DB queue and rechecks visibility after it',async()=>{
  const p=await prepared();const entered=deferred(),release=deferred();try{
    const filename=path.join(p.f.directory,'snapshot-attachment.txt');fs.writeFileSync(filename,'test');
    const metadata=JSON.stringify({attachments:[{id:randomUUID(),kind:'uploaded_file',name:'test.txt',path:filename,size:4,mimeType:'text/plain',available:true}]}).replaceAll("'","''");
    p.f.mutate(`UPDATE messages SET metadata='${metadata}' WHERE id='sync-user'`);
    const original=(p.port as any).attachmentProbe.check.bind((p.port as any).attachmentProbe);
    (p.port as any).attachmentProbe.check=async(paths:string[])=>{entered.resolve();await release.promise;return original(paths);};
    const outcome=p.port.readSessionSync({principal:principal('other'),sessionId:session,includeMessages:true}).then(value=>({value}),error=>({error}));
    await entered.promise;assert.equal((await p.port.readPublicUser({principal:principal(),userId:'owner'})).id,'owner');
    p.f.mutate(`DELETE FROM project_members WHERE user_id='other' AND project_id='${project}'`);release.resolve();
    const result=await outcome;assert.ok('error' in result);assert.equal(result.error.code,'FORBIDDEN');
  }finally{release.resolve();await p.cleanup();}
});

test('continuous durable changes exhaust a bounded retry count without sending a false empty snapshot',async()=>{
  const p=await prepared();const queued:Promise<unknown>[]=[];try{
    const a=await p.client();await p.sync.connect(a.c);a.socket.messages=[];const original=p.port.readSessionSync.bind(p.port);let calls=0;
    p.port.readSessionSync=async(request)=>{const value=await original(request);calls++;
      queued.push(p.hub.broadcastSession({type:'session_updated',sessionId:session,session:value.session}));return value;};
    await assert.rejects(p.sync.subscribe(a.c,session),/FRONTEND_SNAPSHOT_STALE/);await Promise.all(queued);
    assert.equal(calls,3);assert.equal(a.socket.messages.length,0);assert.equal(a.c.subscribedSessionIds.size,0);
  }finally{await Promise.allSettled(queued);await p.cleanup();}
});

test('initial approval list is reauthorized when session ownership changes after its query',async()=>{
  const p=await prepared();try{
    const runtime=p.running();runtime.turnItems=[{id:'approval',type:'interaction',status:'in_progress',details:{interactionKind:'command_approval',command:'old owner request'}}];
    runtime.pendingInteractions.set('approval',{createdAt:1,connectionId:'live-connection',interaction:{kind:'command_approval'}} as any);
    const a=await p.client(),entered=deferred(),release=deferred(),original=p.port.readFrontendSync.bind(p.port);let once=true;
    p.port.readFrontendSync=async(request)=>{const value=await original(request);if(once){once=false;entered.resolve();await release.promise;}return value;};
    const work=p.sync.connect(a.c);await entered.promise;p.f.mutate(`UPDATE sessions SET owner_user_id='other' WHERE id='${session}'`);release.resolve();
    assert.equal(await work,true);assert.deepEqual(a.socket.messages.filter((m)=>m.type==='pending_approvals_snapshot').map((m)=>m.approvals),[[]]);
  }finally{await p.cleanup();}
});

test('remaining project-view access cannot receive owner-only followups after ownership changes between frames',async()=>{
  const p=await prepared();try{
    const a=await p.client();await p.sync.connect(a.c);a.socket.messages=[];let changed=false;
    a.socket.onSend=(event)=>{if(event.type==='session_updated'&&!changed){changed=true;p.f.mutate(`UPDATE sessions SET owner_user_id='other' WHERE id='${session}'`);}};
    assert.equal(await p.sync.subscribe(a.c,session),true);
    assert.equal(a.socket.messages.some((m)=>m.type==='session_followup_snapshot'),false);
    assert.equal(a.socket.messages.some((m)=>m.type==='sync_state'),true);assert.equal(a.socket.closes.length,0);
  }finally{await p.cleanup();}
});

test('absorbing one reconnecting connection stream does not discard live updates on another connection',async()=>{
  const p=await prepared();const observed=deferred();try{
    const runtime=p.running(),a=await p.client(),b=await p.client();await p.sync.connect(a.c);await p.sync.connect(b.c);await p.hub.subscribe(b.c,session);
    a.socket.messages=[];b.socket.messages=[];b.socket.onSend=(event)=>{if(event.type==='delta')observed.resolve();};
    const gate=p.pauseRead(),work=p.sync.subscribe(a.c,session);await gate.entered.promise;runtime.currentContent='AB';
    const update=p.hub.broadcastSession({type:'delta',sessionId:session,itemId:'text',content:'B'});await observed.promise;
    gate.release.resolve();assert.equal(await work,true);await update;
    assert.equal(a.socket.messages.find((m)=>m.type==='sync_state').currentContent,'AB');assert.equal(a.socket.messages.some((m)=>m.type==='delta'),false);
    assert.deepEqual(b.socket.messages.filter((m)=>m.type==='delta').map((m)=>m.content),['B']);
  }finally{await p.cleanup();}
});
