import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { StoredSessionRead } from './stored-session-read.js';
import { StoredFrontendHub } from './stored-frontend-hub.js';
import type { FrontendClient } from './frontend-client-hub.js';
import { hashSessionToken } from '../auth/session.js';

const project='11111111-1111-4111-8111-111111111111',session='22222222-2222-4222-8222-222222222222';
const principal=(id='owner')=>({kind:'user' as const,userId:id,authSessionHash:hashSessionToken(`synthetic-receipt-${id}`)});
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function prepared(){
  const f=fixture();f.mutate(`INSERT INTO projects(id,owner_user_id,path,name) VALUES('${project}','owner','D:/synthetic-read-receipt','Receipt');
    INSERT INTO sessions(id,owner_user_id,project_id,status,engine,message_revision) VALUES('${session}','owner','${project}','completed','codex',1);
    INSERT INTO messages(id,session_id,turn_id,role,content,phase,created_at) VALUES('result-one','${session}','turn-one','assistant','First','final_answer',1)`);
  for(const id of ['owner','other','admin'])f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${principal(id).authSessionHash}','${id}',${Date.now()+600000})`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'read-store',generation:1,initialize:true}),hub=new StoredFrontendHub(port);
  const clients:FrontendClient[]=[];
  const client=async(id='owner')=>{const auth=(await port.authenticateSession({tokenHash:principal(id).authSessionHash}))!,messages:unknown[]=[];
    const socket={readyState:1,bufferedAmount:0,send:(data:string,callback:(error?:Error)=>void)=>{messages.push(JSON.parse(data));callback();},close(){this.readyState=3;}};
    const c:FrontendClient={ws:socket as any,userId:id,user:auth.user,actor:{userId:id,role:auth.user.role},authTokenHash:principal(id).authSessionHash,authExpiresAt:auth.expiresAt,authExpiryTimer:null,
      ip:'127.0.0.1',activeSubscriptionSessionId:session,subscribedSessionIds:new Set([session])};
    clients.push(c);return{c,socket,messages};
  };
  const services:StoredSessionRead[]=[];
  const make=(overrides:Partial<ConstructorParameters<typeof StoredSessionRead>[0]>={})=>{const service=new StoredSessionRead({port,storeId:'read-store',generation:1,
    publishCurrent:async(userId,sessionId)=>hub.broadcastSessionRead(userId,sessionId,p=>port.readSessionReadReceipt({principal:p,sessionId})),...overrides});services.push(service);return service;};
  const proxy=(overrides:Partial<CoreStoragePort>)=>new Proxy(port,{get(target,key){const value=Reflect.get(overrides,key)??Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as CoreStoragePort;
  const input={type:'mark_session_read' as const,sessionId:session,messageId:'result-one'};
  const receipt=(id='owner')=>port.readSessionReadReceipt({principal:principal(id),sessionId:session});
  const next=()=>f.mutate(`INSERT INTO messages(id,session_id,turn_id,role,content,phase,created_at) VALUES('result-two','${session}','turn-two','assistant','Second','final_answer',2)`);
  return{f,port,hub,client,make,proxy,input,receipt,next,cleanup:async()=>{await Promise.all(services.map(s=>s.close()));hub.dispose();for(const c of clients)if(c.authExpiryTimer)clearTimeout(c.authExpiryTimer);await port.close();f.cleanup();}};
}

test('Native read receipt is committed before authorized same-user multi-device publication',async()=>{
  const p=await prepared();try{const first=await p.client(),second=await p.client(),other=await p.client('other'),admin=await p.client('admin');
    for(const client of [first,second,other,admin])await p.hub.add(client.c);
    first.c.activeSubscriptionSessionId=session;
    assert.equal(await p.make().handle(first.c,p.input),true);assert.deepEqual(await p.receipt(),{messageId:'result-one'});
    for(const client of [first,second])assert.deepEqual(client.messages,[{type:'session_reads',receipts:{[session]:'result-one'}}]);
    assert.deepEqual(other.messages,[]);assert.deepEqual(admin.messages,[]);assert.deepEqual(await p.receipt('admin'),{messageId:null});
  }finally{await p.cleanup();}
});
test('replaying an older committed command publishes the current receipt and never rolls it back',async()=>{
  const p=await prepared();try{const c=await p.client();await p.hub.add(c.c);c.c.activeSubscriptionSessionId=session;const service=p.make();
    assert.equal(await service.handle(c.c,p.input),true);p.next();assert.equal(await service.handle(c.c,{...p.input,messageId:'result-two'}),true);
    c.messages.length=0;assert.equal(await service.handle(c.c,p.input),true);assert.deepEqual(await p.receipt(),{messageId:'result-two'});
    assert.deepEqual(c.messages,[{type:'session_reads',receipts:{[session]:'result-two'}}]);
    assert.equal(await service.handle(c.c,{...p.input,messageId:'missing'}),false);assert.deepEqual(await p.receipt(),{messageId:'result-two'});
  }finally{await p.cleanup();}
});
test('inactive subscriptions, malformed commands and stale logins cannot persist reads',async()=>{
  const p=await prepared();try{const c=await p.client(),service=p.make();
    c.c.activeSubscriptionSessionId=null;assert.equal(await service.handle(c.c,p.input),false);c.c.activeSubscriptionSessionId=session;
    assert.equal(await service.handle(c.c,{...p.input,principal:{kind:'system',purpose:'maintenance'}}),false);
    c.c.authExpiresAt=0;assert.equal(await service.handle(c.c,p.input),false);assert.deepEqual(await p.receipt(),{messageId:null});
  }finally{await p.cleanup();}
});
test('identity, active view and service closure are rechecked after asynchronous authorization',async()=>{
  for(const mode of ['identity','view','close']){const p=await prepared(),entered=gate(),release=gate();try{
    const c=await p.client();const port=p.proxy({readFrontendAccess:async(input)=>{entered.resolve();await release.promise;return p.port.readFrontendAccess(input);}});
    const service=p.make({port}),run=service.handle(c.c,p.input);await entered.promise;
    let closing:Promise<void>|undefined;
    if(mode==='identity')c.c.authTokenHash='changed';else if(mode==='view')c.c.activeSubscriptionSessionId=null;else closing=service.close();
    release.resolve();assert.equal(await run,false);await closing;assert.deepEqual(await p.receipt(),{messageId:null});
  }finally{release.resolve();await p.cleanup();}}
});
test('permission revocation before execution blocks both write and private receipt reads',async()=>{
  const p=await prepared();try{const c=await p.client('other');assert.equal(await p.make().handle(c.c,p.input),false);
    await assert.rejects(p.receipt('other'),{code:'FORBIDDEN'});
    p.f.mutate(`INSERT INTO project_members VALUES('${project}','other','viewer',1,1,1)`);assert.equal(await p.make().handle(c.c,p.input),true);assert.deepEqual(await p.receipt('other'),{messageId:'result-one'});
    assert.equal(await p.make().handle(c.c,p.input),true);
    const operationId=p.f.scalar("SELECT operation_id FROM _relay_storage_operations LIMIT 1") as string;
    assert.equal((await p.port.lookup({storeId:'read-store',principal:principal('other'),operationId})).state,'committed');
    p.f.mutate(`DELETE FROM project_members WHERE user_id='other'`);await assert.rejects(p.receipt('other'),{code:'FORBIDDEN'});assert.equal(await p.make().handle(c.c,p.input),false);
    await assert.rejects(p.port.lookup({storeId:'read-store',principal:principal('other'),operationId}),{code:'FORBIDDEN'});
    const replay=await p.port.execute({protocolVersion:1,storeId:'read-store',workerGeneration:1,requestId:'read-revoked-replay',operationId,principal:principal('other'),command:{name:'session.markRead',input:{sessionId:session,messageId:'result-one'}}});
    assert.equal(replay.state,'rejected');if(replay.state==='rejected')assert.equal(replay.code,'FORBIDDEN');
  }finally{await p.cleanup();}
});
test('publisher rechecks resource visibility after loading and does not send revoked receipt data',async()=>{
  const p=await prepared();try{const c=await p.client();await p.hub.add(c.c);c.c.activeSubscriptionSessionId=session;await p.make({publishCurrent:async()=>{}}).handle(c.c,p.input);
    await p.hub.broadcastSessionRead('owner',session,async(principal)=>{const result=await p.port.readSessionReadReceipt({principal,sessionId:session});p.f.mutate(`UPDATE sessions SET deleted_at=1 WHERE id='${session}'`);return result;});
    assert.ok(!c.messages.some((m:any)=>m.type==='session_reads'));
  }finally{await p.cleanup();}
});
test('lost database replies use the exact receipt, while unavailable lookup never publishes success',async()=>{
  for(const lookupAvailable of [true,false]){const p=await prepared();try{const c=await p.client();let published=0;
    const port=p.proxy({execute:async(request:any)=>{await p.port.execute(request);return{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'};},
      ...(!lookupAvailable?{lookup:async()=>{throw new Error('private failure');}}:{})} as any);
    assert.equal(await p.make({port,publishCurrent:async()=>{published++;}}).handle(c.c,p.input),lookupAvailable);assert.equal(published,Number(lookupAvailable));assert.deepEqual(await p.receipt(),{messageId:'result-one'});
  }finally{await p.cleanup();}}
});
test('concurrent identical read commands share work and publication failure retains committed receipts',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{const c=await p.client();let executions=0;
    const port=p.proxy({execute:async(request:any)=>{executions++;entered.resolve();await release.promise;return p.port.execute(request);}} as any);
    const service=p.make({port,publishCurrent:async()=>{throw new Error('unavailable');}}),first=service.handle(c.c,p.input);await entered.promise;const second=service.handle(c.c,p.input);release.resolve();
    assert.equal(await first,true);assert.equal(await second,true);assert.equal(executions,1);assert.deepEqual(await p.receipt(),{messageId:'result-one'});
    await service.close();await assert.rejects(service.handle(c.c,p.input),{code:'NOT_SUBMITTED'});
  }finally{release.resolve();await p.cleanup();}
});

test('bounded handler admission rejects the 129th distinct pending command and drains on close',async()=>{
  const p=await prepared(),release=gate();try{const c=await p.client();const port=p.proxy({readFrontendAccess:async(input)=>{await release.promise;return p.port.readFrontendAccess(input);}});
    const service=p.make({port}),work=Array.from({length:128},(_,i)=>service.handle(c.c,{...p.input,messageId:`synthetic-${i}`}));
    await assert.rejects(service.handle(c.c,{...p.input,messageId:'overflow'}),{code:'OVERLOADED'});
    const closing=service.close();release.resolve();assert.ok((await Promise.all(work)).every(value=>value===false));await closing;
    assert.deepEqual(await p.receipt(),{messageId:null});
  }finally{release.resolve();await p.cleanup();}
});

test('private receipt read rejects extra fields, current disabled login and deleted resources',async()=>{
  const p=await prepared();try{
    await assert.rejects(p.port.readSessionReadReceipt({principal:principal(),sessionId:session,userId:'other'} as any),{code:'INVALID_ARGUMENT'});
    p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");await assert.rejects(p.receipt(),{code:'FORBIDDEN'});
    p.f.mutate(`UPDATE users SET disabled_at=NULL WHERE id='owner';UPDATE sessions SET deleted_at=1 WHERE id='${session}'`);await assert.rejects(p.receipt(),{code:'FORBIDDEN'});
  }finally{await p.cleanup();}
});
