import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StoredSessionForkService } from './stored-session-fork.js';
import { createStoredSessionForkRouter } from '../routes/stored-session-fork.js';
import { serializeSessionCookie } from '../auth/cookie.js';
import { hashSessionToken } from '../auth/session.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { ProjectUploadStore } from '../uploads/project-uploads.js';
import { ForkUploadCopier } from '../uploads/fork-copy-worker.js';

const principal={kind:'user' as const,userId:'owner',authSessionHash:'auth-owner'};
const sessionId='22222222-2222-4222-8222-222222222222';
async function prepared(attachments=false) {
  const f=fixture();
  f.mutate(`INSERT INTO sessions(id,owner_user_id,project_id,status,message_revision,engine,engine_bound,codex_thread_id,engine_session_id,active_attempt_id)
    VALUES('${sessionId}','owner','project','idle',2,'codex',1,'parent-thread','parent-thread',NULL);UPDATE messages SET session_id='${sessionId}';DELETE FROM engine_resource_leases`);
  if(attachments){
    const metadata=JSON.stringify({attachments:[{kind:'uploaded_file',id:'33333333-3333-4333-8333-333333333333',name:'file.txt',
      path:path.join('D:/synthetic','.relay_upload','messages','m2','file.txt'),size:3,mimeType:'text/plain',available:true}]}).replaceAll("'","''");
    f.mutate(`UPDATE messages SET metadata='${metadata}' WHERE id='m2'`);
  }
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  let calls=0,notifications=0,copies=0;
  const defaults={port:port as CoreStoragePort,storeId:'store',generation:1,
    fork:async(_plan:unknown,guard:()=>Promise<boolean>)=>{assert.equal(await guard(),true);calls++;return 'child-thread';},
    copy:async(input:any)=>{copies++;return [{kind:'uploaded_file' as const,id:randomUUID(),name:'file.txt',size:3,mimeType:'text/plain',available:true,
      path:path.join(input.projectPath,'.relay_upload','messages',input.targetMessageId,'file.txt')}];},
    changed:async()=>{notifications++;}};
  const service=(overrides:Partial<typeof defaults>&{externalTimeoutMs?:number}={})=>new StoredSessionForkService({...defaults,...overrides});
  return {f,port,defaults,service,counters:()=>({calls,notifications,copies}),cleanup:async()=>{await port.close();f.cleanup();}};
}
test('shutdown retains a timed-out fork until its returned child identity is durably acknowledged',async()=>{
  const p=await prepared();let release!:()=>void,entered!:()=>void,calls=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const service=p.service({externalTimeoutMs:10,fork:async(_plan,mayDispatch)=>{assert.equal(await mayDispatch(),true);calls++;entered();await gate;return'late-child';}}),key=randomUUID();
  try{
    const work=service.run(principal,sessionId,null,key);await started;assert.deepEqual(await work,{state:'unknown'});
    let closed=false;const closing=service.close().then(()=>{closed=true;});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(closed,false);
    release();await closing;assert.equal(p.f.scalar('SELECT child_id FROM _relay_forks'),'late-child');
    await assert.rejects(service.run(principal,sessionId,null,key),/NOT_SUBMITTED/);
    assert.equal((await p.service().run(principal,sessionId,null,key)).state,'committed');assert.equal(calls,1);assert.equal(p.counters().calls,0);
  }finally{release();await service.close();await p.cleanup();}
});
test('fork coordinator confirms reply loss through the exact operation receipt and same-key retries never fork twice',async()=>{
  const p=await prepared();
  try{
    let lost=false;
    const proxy=new Proxy(p.port,{get(target,key){if(key==='execute')return async(request:any)=>{
      const value=await target.execute(request);if(request.command.name==='session.finishFork'&&!lost){lost=true;return {state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'};}return value;
    };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    const service=p.service({port:proxy}),key=randomUUID();
    const result=await service.run(principal,sessionId,null,key);assert.equal(result.state,'committed');
    assert.equal(p.counters().calls,1);assert.equal(p.f.scalar('SELECT count(*) FROM sessions'),3);
    assert.equal((await p.service().run(principal,sessionId,null,key)).state,'committed');assert.equal(p.counters().calls,1);
    await assert.rejects(service.run(principal,sessionId,'m1',key),{code:'CONFLICT'});
  }finally{await p.cleanup();}
});
test('ambiguous external result survives service replacement and new HTTP keys without redispatch',async()=>{
  const p=await prepared();let calls=0;
  try{
    const make=()=>p.service({fork:async()=>{calls++;throw new Error('synthetic lost external reply');}}),key=randomUUID();
    assert.equal((await make().run(principal,sessionId,null,key)).state,'unknown');
    assert.equal((await make().run(principal,sessionId,null,key)).state,'unknown');
    assert.equal((await make().run(principal,sessionId,null,randomUUID())).state,'unknown');
    assert.equal(calls,1);assert.equal(p.f.scalar('SELECT count(*) FROM sessions'),2);
  }finally{await p.cleanup();}
});
test('known child is durable before attachments; retry resumes local work without another provider fork',async()=>{
  const p=await prepared(true);let failed=true;
  try{
    const service=p.service({copy:async(input:any)=>{if(failed){failed=false;throw new Error('synthetic file failure');}return p.defaults.copy(input);}}),key=randomUUID();
    assert.equal((await service.run(principal,sessionId,null,key)).state,'unknown');
    assert.equal(p.f.scalar('SELECT child_id FROM _relay_forks'),'child-thread');assert.equal(p.f.scalar('SELECT count(*) FROM sessions'),2);
    const result=await p.service().run(principal,sessionId,null,key);assert.equal(result.state,'committed');assert.equal(p.counters().calls,1);
    assert.equal(p.f.scalar('SELECT count(*) FROM sessions'),3);
    assert.equal(p.f.scalar("SELECT count(*) FROM _relay_external_operations WHERE phase='applied'"),1);
  }finally{await p.cleanup();}
});
test('late provider reply records a proven child after deadline and auth/source change without creating user resources',async()=>{
  const p=await prepared();let release!:(child:string)=>void,entered!:()=>void;
  const ready=new Promise<void>((resolve)=>{entered=resolve;}),reply=new Promise<string>((resolve)=>{release=resolve;});
  try{
    const service=p.service({externalTimeoutMs:1,fork:async()=>{entered();return reply;}});
    const work=service.run(principal,sessionId,null,randomUUID());await ready;assert.equal((await work).state,'unknown');
    p.f.mutate("DELETE FROM auth_sessions WHERE token_hash='auth-owner';UPDATE messages SET content='changed while external RPC pending' WHERE id='m1'");
    release('late-child');await Promise.all([...(service as any).dispatches]);
    assert.equal(p.f.scalar('SELECT child_id FROM _relay_forks'),'late-child');assert.equal(p.f.scalar('SELECT count(*) FROM sessions'),2);
    assert.equal(p.f.scalar("SELECT count(*) FROM _relay_external_operations WHERE phase='dispatched'"),1);
  }finally{release?.('late-child');await p.cleanup();}
});
test('source mutation during file copying prevents the final atomic insert and does not archive a known child',async()=>{
  const p=await prepared(true);
  try{
    const service=p.service({copy:async(input:any)=>{const value=await p.defaults.copy(input);p.f.mutate("UPDATE messages SET content='changed during copy' WHERE id='m1'");return value;}});
    await assert.rejects(service.run(principal,sessionId,null,randomUUID()),{code:'CONFLICT'});
    assert.equal(p.f.scalar('SELECT count(*) FROM sessions'),2);assert.equal(p.f.scalar('SELECT child_id FROM _relay_forks'),'child-thread');assert.equal(p.counters().calls,1);
  }finally{await p.cleanup();}
});
test('postcommit notification and projection failures do not turn a saved fork into a rejected write',async()=>{
  const p=await prepared();
  try{
    const proxy=new Proxy(p.port,{get(target,key){if(key==='readSession')return async()=>{throw new Error('synthetic projection failure');};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    const result=await p.service({port:proxy,changed:async()=>{throw new Error('synthetic notification failure');}}).run(principal,sessionId,null,randomUUID());
    assert.deepEqual(result,{state:'committed',session:null});assert.equal(p.f.scalar('SELECT count(*) FROM sessions'),3);
  }finally{await p.cleanup();}
});

test('external dispatch slots are reserved before awaiting a claim, so 17 concurrent intents cannot pass a limit of 16',async()=>{
  const p=await prepared();let release!:()=>void,ready!:()=>void,claims=0;
  const gate=new Promise<void>((resolve)=>{release=resolve;}),started=new Promise<void>((resolve)=>{ready=resolve;});
  const sessions=Array.from({length:17},()=>randomUUID());
  p.f.mutate(sessions.map((id)=>`INSERT INTO sessions(id,owner_user_id,project_id,status,message_revision,engine,engine_bound,codex_thread_id,engine_session_id)
    VALUES('${id}','owner','project','idle',1,'codex',1,'parent-${id}','parent-${id}');
    INSERT INTO messages(id,session_id,turn_id,role,content,phase,created_at,stopped) VALUES('${randomUUID()}','${id}','turn','assistant','synthetic','final_answer',1,0)`).join(';'));
  const proxy=new Proxy(p.port,{get(target,key){if(key==='execute')return async(request:any)=>{
    if(request.command.name==='session.claimFork'){claims++;if(claims===16)ready();await gate;}
    return target.execute(request);
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const service=p.service({port:proxy,fork:async(plan:any)=>`child-${plan.sessionId}`});
  const outcomes=Promise.all(sessions.map((id)=>service.run(principal,id,null,randomUUID()).then((value)=>({value}),error=>({error}))));
  try{
    await started;await p.port.readPublicUser({principal,userId:'owner'});
    await new Promise<void>((resolve)=>setImmediate(resolve));
    assert.equal(claims,16);
    release();const results=await outcomes;
    assert.equal(results.filter((r)=>'error' in r&&r.error.code==='OVERLOADED').length,1);
    assert.equal(results.filter((r)=>'value' in r&&r.value.state==='committed').length,16);
  }finally{release();await outcomes;await p.cleanup();}
});
test('candidate fork HTTP preserves 201 and auth/origin/strict input gates with an echoed operation ID',async()=>{
  const p=await prepared();
  try{
    const token='synthetic-fork-http',cookie=serializeSessionCookie(token,Date.now()+600_000,false),key=randomUUID();
    p.f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${hashSessionToken(token)}','owner',${Date.now()+600_000})`);
    const app=new Hono().route('/api',createStoredSessionForkRouter({port:p.port,service:p.service(),assertNotDeleting:()=>{}}));
    const send=(body:unknown,origin='http://localhost:9081')=>app.request(`http://localhost:9081/api/sessions/${sessionId}/fork`,{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-relay-operation-id':key},body:JSON.stringify(body)});
    assert.equal((await send({path:'forbidden'})).status,400);assert.equal((await send({},'https://untrusted.invalid')).status,403);
    const result=await send({});assert.equal(result.status,201);assert.equal(result.headers.get('x-relay-operation-id'),key);assert.equal((await result.json()).ok,true);
    assert.equal((await send({})).status,201);assert.equal(p.counters().calls,1);
    p.f.mutate("UPDATE users SET must_change_password=1 WHERE id='owner'");assert.equal((await send({})).status,403);
  }finally{await p.cleanup();}
});

test('admin fork uses actual file Worker and atomically commits its own same-directory project and verified copied attachments',async()=>{
  const f=fixture(),copier=new ForkUploadCopier(),sourceUser=randomUUID(),adminUser=randomUUID(),projectId=randomUUID(),sourceMessageId=randomUUID();
  const root=path.join(f.directory,'project');fs.mkdirSync(root);
  let port:StorageWorkerClient|undefined;
  try{
    const store=new ProjectUploadStore();async function* bytes(){yield Buffer.from('real synthetic file');}
    const draft=await store.writeUpload({projectPath:root,projectId,userId:sourceUser,messageId:sourceMessageId,uploadId:randomUUID(),name:'shared.txt',mimeType:'text/plain',declaredSize:19,body:bytes()});
    const source=store.prepareArchive({projectPath:root,projectId,userId:sourceUser,messageId:sourceMessageId,drafts:[draft]}).attachments;
    const metadata=JSON.stringify({attachments:source}).replaceAll("'","''"),escapedRoot=root.replaceAll("'","''");
    f.mutate(`INSERT INTO users(id,role,username,created_at,updated_at,must_change_password) VALUES('${sourceUser}','member','synthetic-source',1,1,0),('${adminUser}','admin','synthetic-admin',1,1,0);
      INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('integration-admin','${adminUser}',${Date.now()+600_000});
      INSERT INTO projects(id,owner_user_id,path,name) VALUES('${projectId}','${sourceUser}','${escapedRoot}','integration');
      INSERT INTO sessions(id,owner_user_id,project_id,status,message_revision,engine,engine_bound,codex_thread_id,engine_session_id) VALUES('${sessionId}','${sourceUser}','${projectId}','idle',1,'codex',1,'parent','parent');
      INSERT INTO messages(id,session_id,turn_id,role,content,metadata,created_at,stopped) VALUES('${sourceMessageId}','${sessionId}','turn','user','with file','${metadata}',1,0)`);
    port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
    let dispatched=0;
    const service=new StoredSessionForkService({port,storeId:'store',generation:1,fork:async(_plan,guard)=>{assert.equal(await guard(),true);dispatched++;return 'integration-child';},copy:(input)=>copier.copy(input),changed:()=>{}});
    const actor={kind:'user' as const,userId:adminUser,authSessionHash:'integration-admin'},key=randomUUID();
    const result=await service.run(actor,sessionId,null,key);assert.equal(result.state,'committed');
    if(result.state!=='committed'||!result.session)throw new Error('Missing committed projection');
    assert.equal(f.scalar(`SELECT owner_user_id FROM sessions WHERE id='${result.session.id}'`),adminUser);
    assert.equal(f.scalar(`SELECT owner_user_id FROM projects WHERE id='${result.session.project_id}'`),adminUser);
    const saved=JSON.parse(String(f.scalar(`SELECT metadata FROM messages WHERE session_id='${result.session.id}'`))).attachments[0];
    assert.equal(fs.readFileSync(saved.path,'utf8'),'real synthetic file');assert.notEqual(saved.path,source[0]!.path);
    const manifest=JSON.parse(fs.readFileSync(path.join(path.dirname(saved.path),'manifest.json'),'utf8'));
    assert.equal(manifest.userId,adminUser);assert.equal(manifest.projectId,result.session.project_id);assert.equal(fs.readFileSync(source[0]!.path,'utf8'),'real synthetic file');
    assert.equal((await service.run(actor,sessionId,null,key)).state,'committed');assert.equal(dispatched,1);
  }finally{await copier.dispose();await port?.close();f.cleanup();}
});
