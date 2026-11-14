import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { NativeStore } from '../storage/native-store.js';
import { StoredShares } from './stored-shares.js';
import { createStoredSharesRouter,createStoredPublicSharesRouter } from '../routes/stored-shares.js';
import { hashSessionToken } from '../auth/session.js';
import { serializeSessionCookie } from '../auth/cookie.js';
import type { CreateShareRequest } from '../contracts/index.js';
const session='22222222-2222-4222-8222-222222222222',project='11111111-1111-4111-8111-111111111111',first='33333333-3333-4333-8333-333333333333',last='44444444-4444-4444-8444-444444444444';
const principal=(id='owner')=>({kind:'user' as const,userId:id,authSessionHash:hashSessionToken(`synthetic-share-${id}`)});
const request:CreateShareRequest={sessionId:session,title:'Synthetic share',scope:'session',includeProcess:true,expiry:{type:'permanent'}};
async function prepared(){
  const f=fixture(),filename=path.join(f.directory,'source.txt');fs.writeFileSync(filename,'test');
  const metadata=JSON.stringify({attachments:[{id:randomUUID(),kind:'uploaded_file',name:'source.txt',path:filename,size:4,mimeType:'text/plain',available:false}]}).replaceAll("'","''");
  const items=JSON.stringify([{id:'command',type:'commandExecution',status:'completed',details:{command:'echo synthetic',cwd:'D:/private',aggregatedOutput:'result',privateToken:'must-not-publish'}}]).replaceAll("'","''");
  f.mutate(`INSERT INTO projects(id,owner_user_id,path) VALUES('${project}','owner','D:/sharing');
    INSERT INTO sessions(id,owner_user_id,project_id,status,engine,engine_bound,message_revision) VALUES('${session}','owner','${project}','completed','codex',1,3);
    INSERT INTO messages(id,session_id,turn_id,role,content,phase,items,metadata,created_at,stopped) VALUES
    ('${first}','${session}','turn','user','question',NULL,NULL,'${metadata}',10,0),
    ('${last}','${session}','turn','assistant','answer','final_answer','${items}',NULL,20,0),
    ('${randomUUID()}','${session}','next','user','future input must not publish',NULL,NULL,NULL,30,0);
    INSERT INTO project_members VALUES('${project}','other','viewer',1,1,1)`);
  for(const id of ['owner','other','admin'])f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${principal(id).authSessionHash}','${id}',${Date.now()+600000})`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const service=new StoredShares({port,storeId:'store',generation:1});
  const app=new Hono().route('/api/shares',createStoredSharesRouter({port,service})).route('/api/public-shares',createStoredPublicSharesRouter({port,getClientId:()=> 'synthetic-client'}));
  const send=(route:string,method='GET',body?:unknown,user='owner',key=randomUUID(),origin='http://localhost:9081')=>app.request(`http://localhost:9081${route}`,{method,headers:{cookie:serializeSessionCookie(`synthetic-share-${user}`,Date.now()+600000,false),origin,'content-type':'application/json','x-relay-operation-id':key},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const create=async(value:CreateShareRequest=request,key=randomUUID(),actor=principal())=>{const result=await service.create(actor,value,key);assert.equal(result.state,'committed');return (result as any).value as {id:string;publicToken:string};};
  return {f,filename,port,service,app,send,create,cleanup:async()=>{await port.close();f.cleanup();}};
}
test('share preview is read-only, immutable output is bounded to the completed cutoff and filesystem-free in the transaction',async()=>{
  const p=await prepared();try{
    const preview=await p.service.preview(principal(),request);assert.equal(preview.messageCount,2);assert.equal(p.f.scalar('SELECT count(*) FROM shared_records'),0);
    const text=JSON.stringify(preview);assert.equal(text.includes(p.filename),false);assert.equal(text.includes('must-not-publish'),false);assert.equal(text.includes('D:/private'),false);assert.equal(text.includes('future input'),false);
    assert.equal(preview.snapshot.messages[0]!.attachments?.[0]?.kind==='uploaded_file'&&(preview.snapshot.messages[0]!.attachments?.[0] as any).available,true);
    const prepared=await p.port.previewShare({principal:principal(),request});await p.port.close();
    const native=new NativeStore(p.f.filename,'store',2),original=fs.lstatSync;
    try{fs.lstatSync=(()=>{throw new Error('TRANSACTION_FILE_IO');}) as any;
      const result=native.execute({protocolVersion:1,storeId:'store',workerGeneration:2,requestId:'pure-share',operationId:'pure-share',principal:principal(),command:{name:'share.create',input:{request,sourceDigest:prepared.sourceDigest,availability:prepared.availability}}});
      assert.equal(result.state,'committed');
    }finally{fs.lstatSync=original;native.close();}
  }finally{await p.cleanup();}
});
test('share snapshots survive source edits and soft deletion, and same-key retries never recreate a link',async()=>{
  const p=await prepared();try{
    const key=randomUUID(),saved=await p.create(request,key);assert.match(saved.publicToken,/^[a-f0-9]{64}$/);
    p.f.mutate(`UPDATE messages SET content='new content' WHERE id='${last}';UPDATE sessions SET deleted_at=1 WHERE id='${session}'`);
    const publicValue=await p.port.readPublicShare({token:saved.publicToken});assert.equal(publicValue.state,'active');if(publicValue.state==='active')assert.equal(publicValue.snapshot.messages.at(-1)?.content,'answer');
    assert.deepEqual(await p.create(request,key),saved);assert.equal(p.f.scalar('SELECT count(*) FROM shared_records'),1);
    await assert.rejects(p.service.create(principal(),{...request,title:'changed intent'},key),{code:'CONFLICT'});
  }finally{await p.cleanup();}
});
test('selection enforces completed cutoff, existing IDs, empty selection and per-source authorization',async()=>{
  const p=await prepared();try{
    assert.equal((await p.service.preview(principal(),{...request,scope:'single',messageIds:[last]})).messageCount,1);
    assert.equal((await p.service.preview(principal(),{...request,scope:'selection',messageIds:[last,first]})).snapshot.messages[0]!.id,first);
    await assert.rejects(p.service.preview(principal(),{...request,scope:'selection',messageIds:[]}),{code:'INVALID_ARGUMENT'});
    await assert.rejects(p.service.preview(principal(),{...request,scope:'single',messageIds:[randomUUID()]}),{code:'INVALID_ARGUMENT'});
    await assert.rejects(p.service.preview(principal('other'),request),{code:'FORBIDDEN'});
    p.f.mutate(`UPDATE projects SET deleted_at=1 WHERE id='${project}'`);await assert.rejects(p.service.preview(principal(),request),{code:'FORBIDDEN'});
  }finally{await p.cleanup();}
});
test('revoke and delete preserve lifecycle rules, current authority and deleted-record receipt replay',async()=>{
  const p=await prepared();try{
    const saved=await p.create();await assert.rejects(p.service.mutate(principal(),'share.delete',saved.id,randomUUID()),{code:'CONFLICT'});
    await assert.rejects(p.service.mutate(principal('other'),'share.revoke',saved.id,randomUUID()),{code:'FORBIDDEN'});
    assert.equal((await p.service.mutate(principal(),'share.revoke',saved.id,randomUUID())).state,'committed');assert.deepEqual(await p.port.readPublicShare({token:saved.publicToken}),{state:'revoked'});
    const key=randomUUID();assert.equal((await p.service.mutate(principal(),'share.delete',saved.id,key)).state,'committed');assert.equal((await p.service.mutate(principal(),'share.delete',saved.id,key)).state,'committed');
    assert.deepEqual(await p.port.readPublicShare({token:saved.publicToken}),{state:'not_found'});
  }finally{await p.cleanup();}
});
test('expired and unreadable snapshots remain distinct from a missing share',async()=>{
  const p=await prepared();try{
    const saved=await p.create();p.f.mutate(`UPDATE shared_records SET expires_at=1 WHERE id='${saved.id}'`);assert.deepEqual(await p.port.readPublicShare({token:saved.publicToken}),{state:'expired'});
    assert.equal((await p.port.listShares({principal:principal(),limit:50,offset:0})).items[0]!.status,'expired');
    p.f.mutate(`UPDATE shared_records SET expires_at=NULL,snapshot_json='invalid' WHERE id='${saved.id}'`);assert.deepEqual(await p.port.readPublicShare({token:saved.publicToken}),{state:'unreadable'});
    p.f.mutate(`UPDATE shared_records SET snapshot_json=CAST(zeroblob(2097153) AS TEXT) WHERE id='${saved.id}'`);assert.deepEqual(await p.port.readPublicShare({token:saved.publicToken}),{state:'unreadable'});
  }finally{await p.cleanup();}
});
test('source change after probing cannot commit a stale snapshot',async()=>{
  const p=await prepared();try{
    const preview=p.port.previewShare.bind(p.port);p.port.previewShare=async(input)=>{const value=await preview(input);p.f.mutate(`UPDATE messages SET content='changed during prepare' WHERE id='${last}';UPDATE sessions SET message_revision=4 WHERE id='${session}'`);return value;};
    await assert.rejects(p.service.create(principal(),request,randomUUID()),{code:'CONFLICT'});assert.equal(p.f.scalar('SELECT count(*) FROM shared_records'),0);
  }finally{await p.cleanup();}
});
test('reply loss and concurrent independent coordinators converge on one committed share',async()=>{
  const p=await prepared();try{
    const execute=p.port.execute.bind(p.port);let lost=false;p.port.execute=(async(input:any)=>{const value=await execute(input);if(input.command.name==='share.create'&&!lost){lost=true;return {state:'unknown',operationId:input.operationId,cause:'transport',recovery:'lookup'};}return value;}) as any;
    const key=randomUUID(),other=new StoredShares({port:p.port,storeId:'store',generation:1});
    const values=await Promise.all([p.service.create(principal(),request,key),other.create(principal(),request,key)]);assert.deepEqual(values[0],values[1]);assert.equal(values[0]!.state,'committed');assert.equal(p.f.scalar('SELECT count(*) FROM shared_records'),1);
  }finally{await p.cleanup();}
});
test('admin-created shares belong to the actor; audits and operation receipts roll back with the snapshot',async()=>{
  const p=await prepared();try{
    p.f.mutate("CREATE TRIGGER reject_share BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='share.create' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    const result=await p.service.create(principal('admin'),request,randomUUID());assert.equal(result.state,'unknown');assert.equal(p.f.scalar('SELECT count(*) FROM shared_records'),0);
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE action='share.create_from_session' AND result='succeeded'"),0);
    p.f.mutate('DROP TRIGGER reject_share');const saved=await p.create(request,randomUUID(),principal('admin'));
    assert.equal(p.f.scalar(`SELECT owner_user_id FROM shared_records WHERE id='${saved.id}'`),'admin');
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE action='share.create_from_session' AND result='succeeded'"),1);
    assert.equal((await p.port.listShares({principal:principal(),limit:50,offset:0})).total,0);assert.equal((await p.port.listShares({principal:principal('admin'),limit:50,offset:0})).total,1);
  }finally{await p.cleanup();}
});
test('private and public routes retain auth, origin, lifecycle, no-store and honest storage failure semantics',async()=>{
  const p=await prepared();try{
    assert.equal((await p.send('/api/shares/preview','POST',{...request,path:'not accepted'})).status,400);
    assert.equal((await p.send('/api/shares','POST',request,'owner',randomUUID(),'https://untrusted.invalid')).status,403);
    const response=await p.send('/api/shares','POST',request);assert.equal(response.status,201);assert.ok(response.headers.get('x-relay-operation-id'));const saved=await response.json();
    const publicResponse=await p.send(`/api/public-shares/${saved.publicToken}`);assert.equal(publicResponse.status,200);assert.equal(publicResponse.headers.get('Referrer-Policy'),'no-referrer');assert.equal((await publicResponse.json()).state,'active');
    assert.equal((await p.send('/api/public-shares/invalid')).status,404);
    p.port.readPublicShare=async()=>{throw new Error('synthetic unavailable');};const unavailable=await p.send(`/api/public-shares/${saved.publicToken}`);assert.equal(unavailable.status,503);assert.equal((await unavailable.json()).code,'STORAGE_UNAVAILABLE');
    p.f.mutate("UPDATE users SET must_change_password=1 WHERE id='owner'");assert.equal((await p.send('/api/shares/preview','POST',request)).status,403);
  }finally{await p.cleanup();}
});

test('a former admin may manage their immutable share but cannot learn new private source metadata',async()=>{
  const p=await prepared();try{
    const saved=await p.create(request,randomUUID(),principal('admin'));
    p.f.mutate(`UPDATE users SET role='member' WHERE id='admin';UPDATE sessions SET title='new private title' WHERE id='${session}'`);
    const listed=await p.port.listShares({principal:principal('admin'),limit:50,offset:0});assert.equal(listed.items[0]!.sourceSessionTitle,null);
    assert.equal(JSON.stringify(listed).includes('new private title'),false);
    assert.equal((await p.service.mutate(principal('admin'),'share.revoke',saved.id,randomUUID())).state,'committed');
  }finally{await p.cleanup();}
});

test('share count/byte budgets fail explicitly before any record is saved',async()=>{
  const p=await prepared();try{
    p.f.mutate(`UPDATE messages SET content=CAST(zeroblob(2097153) AS TEXT) WHERE id='${last}'`);
    await assert.rejects(p.service.create(principal(),request,randomUUID()),{code:'PAYLOAD_TOO_LARGE'});assert.equal(p.f.scalar('SELECT count(*) FROM shared_records'),0);
    p.f.mutate(`UPDATE messages SET content='answer' WHERE id='${last}';INSERT INTO messages(id,session_id,turn_id,role,content,phase,created_at,stopped) VALUES `+
      Array.from({length:500},()=>`('${randomUUID()}','${session}','old-turn','user','old input',NULL,15,0)`).join(','));
    await assert.rejects(p.service.preview(principal(),request),{code:'PAYLOAD_TOO_LARGE'});
    assert.equal((await p.service.preview(principal(),{...request,scope:'single',messageIds:[last]})).messageCount,1);
  }finally{await p.cleanup();}
});
