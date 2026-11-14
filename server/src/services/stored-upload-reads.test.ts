import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { hashSessionToken } from '../auth/session.js';
import { StoredUploadReads } from './stored-upload-reads.js';
import { readUploadSnapshot,type UploadReadActivity } from '../uploads/read-upload-snapshot.js';
import { createStoredProjectUploadReadsRouter } from '../routes/stored-project-upload-reads.js';
import { ProjectFileActivities } from '../uploads/project-file-activities.js';
import { IncomingUploadJournal } from '../uploads/incoming-upload-journal.js';
const user='11111111-1111-4111-8111-111111111111',project='22222222-2222-4222-8222-222222222222';
const principal={kind:'user' as const,userId:user,authSessionHash:hashSessionToken('synthetic-upload-owner')};
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function prepared(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-upload-reads-')),f=fixture();
  f.mutate(`INSERT INTO users(id,role,username,must_change_password) VALUES('${user}','member','upload-owner',0);
    INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${principal.authSessionHash}','${user}',${Date.now()+600000});
    INSERT INTO projects(id,owner_user_id,path,name) VALUES('${project}','${user}','${root.replaceAll("'","''")}','Uploads');
    INSERT INTO project_members(project_id,user_id,role,can_view_sessions,created_at,updated_at) VALUES('${project}','other','manager',1,1,1)`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'upload-read-test',generation:1,initialize:true}),services:StoredUploadReads[]=[];
  const state={activity:{version:'one',reservations:[]} as UploadReadActivity,calls:0};
  const make=(overrides:Partial<ConstructorParameters<typeof StoredUploadReads>[0]>={})=>{const service=new StoredUploadReads({port,activity:async()=>structuredClone(state.activity),readFiles:async(scope,activity)=>{state.calls++;return readUploadSnapshot(scope,activity);},...overrides});services.push(service);return service;};
  const seed=async(options:{temporary?:boolean;owner?:string;projectId?:string;missing?:boolean;bytes?:number}={})=>{
    const messageId=randomUUID(),uploadId=randomUUID(),attachmentId=randomUUID(),directory=path.join(root,'.relay_upload',options.temporary?'tmp':'messages',messageId);await fs.mkdir(directory,{recursive:true});
    const manifest={version:2,messageId,projectId:options.projectId??project,userId:options.owner??user,createdAt:1,updatedAt:1,attachments:[{uploadId,attachmentId,name:'synthetic.txt',storedName:'synthetic.txt',size:options.bytes??3,mimeType:'text/plain',createdAt:1}]};
    await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest));if(!options.missing)await fs.writeFile(path.join(directory,'synthetic.txt'),Buffer.alloc(options.bytes??3));return{directory,manifest,messageId,uploadId,attachmentId};
  };
  const command=async(name:'trash.prepareSoftDelete'|'trash.abandonSoftDelete',jobId:string)=>port.execute({protocolVersion:1,storeId:'upload-read-test',workerGeneration:1,requestId:randomUUID(),operationId:randomUUID(),principal,command:name==='trash.prepareSoftDelete'?{name,input:{jobId,kind:'project',resourceId:project}}:{name,input:{jobId}}});
  return{root,f,port,state,make,seed,command,cleanup:async()=>{await Promise.all(services.map(s=>s.close()));await port.close();f.cleanup();await fs.rm(root,{recursive:true,force:true});}};
}

test('an empty upload read is read-only and never creates a managed directory or gitignore',async()=>{
  const p=await prepared();try{const value=await p.make().get(principal,project);assert.deepEqual(value.files,[]);assert.equal(value.usage.usedBytes,0);assert.equal(value.cleanupBlockedReason,null);assert.deepEqual(await fs.readdir(p.root),[]);}finally{await p.cleanup();}
});

test('bounded asynchronous inventory accounts for orphan bytes and reserves partial uploads without double counting',async()=>{
  const p=await prepared();try{const archived=await p.seed(),draft=await p.seed({temporary:true,bytes:5}),missing=await p.seed({missing:true});await p.seed({owner:randomUUID(),projectId:randomUUID(),bytes:7});await fs.writeFile(path.join(archived.directory,'orphan.bin'),Buffer.alloc(2));
    const uploadId=randomUUID();await fs.writeFile(path.join(draft.directory,uploadId+'.part'),Buffer.alloc(4));p.state.activity.reservations=[{uploadId,messageId:draft.messageId,size:10}];
    const value=await p.make().get(principal,project);assert.equal(value.usage.usedBytes,17);assert.equal(value.usage.reservedBytes,10);assert.equal(value.usage.archivedFileCount,3);assert.equal(value.usage.temporaryFileCount,1);assert.equal(value.files.length,2);assert.equal(value.files.find(f=>f.id===missing.attachmentId)!.available,false);assert.ok(value.cleanupBlockedReason?.includes('正在上传'));assert.equal(JSON.stringify(value).includes(p.root),false);
  }finally{await p.cleanup();}
});

test('corrupt or oversized manifests fail the complete snapshot instead of returning smaller successful totals',async()=>{
  const p=await prepared();try{const seeded=await p.seed(),filename=path.join(seeded.directory,'manifest.json');await fs.writeFile(filename,'{broken');await assert.rejects(p.make().get(principal,project));await fs.writeFile(filename,'x'.repeat(128*1024+1));await assert.rejects(p.make().get(principal,project),{code:'PAYLOAD_TOO_LARGE'});assert.equal((await fs.stat(filename)).size,128*1024+1);}finally{await p.cleanup();}
});

test('project owners see only their uploaded files while current admins see all uploads of the same project',async()=>{
  const p=await prepared();try{await p.seed();await p.seed({owner:randomUUID()});await p.seed({projectId:randomUUID()});const service=p.make();assert.equal((await service.get(principal,project)).files.length,1);assert.equal((await service.get({kind:'user',userId:'admin',authSessionHash:'auth-admin'},project)).files.length,2);}finally{await p.cleanup();}
});

test('hard-linked payloads cannot be counted or exposed as trusted managed attachments',async()=>{
  const p=await prepared();try{const seeded=await p.seed();await fs.link(path.join(seeded.directory,'synthetic.txt'),path.join(p.root,'alias.txt'));await assert.rejects(p.make().get(principal,project),{code:'CONFLICT'});}finally{await p.cleanup();}
});

test('shared project managers cannot invoke owner upload inventory and authorization precedes filesystem reads',async()=>{
  const p=await prepared();try{await assert.rejects(p.make().get({kind:'user',userId:'other',authSessionHash:'auth-other'},project),{code:'NOT_FOUND'});assert.equal(p.state.calls,0);const admin=await p.port.readUploadScope({principal:{kind:'user',userId:'admin',authSessionHash:'auth-admin'},projectId:project});assert.equal(admin.ownerUserId,user);assert.equal(admin.viewerRole,'admin');}finally{await p.cleanup();}
});

test('source ownership or reservation changes during asynchronous file reads invalidate the result',async()=>{
  for(const mode of ['owner','reservation','expires']){const p=await prepared();try{const service=p.make({readFiles:async(scope,activity)=>{const value=await readUploadSnapshot(scope,activity);if(mode==='owner')p.f.mutate(`UPDATE projects SET owner_user_id='other' WHERE id='${project}'`);else if(mode==='expires')p.f.mutate(`UPDATE auth_sessions SET expires_at=1 WHERE token_hash='${principal.authSessionHash}'`);else p.state.activity.version='two';return value;}});await assert.rejects(service.get(principal,project),{code:mode==='owner'?'NOT_FOUND':mode==='expires'?'FORBIDDEN':'CONFLICT'});}finally{await p.cleanup();}}
});

test('current active work blocks cleanup presentation while pending deletion blocks the file read itself',async()=>{
  const p=await prepared();try{p.f.mutate(`INSERT INTO sessions(id,owner_user_id,project_id,title,status,engine,message_revision) VALUES('${randomUUID()}','${user}','${project}','active','processing','codebuddy',0)`);const service=p.make();assert.ok((await service.get(principal,project)).cleanupBlockedReason?.includes('运行中'));p.f.mutate(`UPDATE sessions SET status='completed' WHERE project_id='${project}'`);const jobId=randomUUID();assert.equal((await p.command('trash.prepareSoftDelete',jobId)).state,'committed');const calls=p.state.calls;await assert.rejects(service.get(principal,project),{code:'CONFLICT'});assert.equal(p.state.calls,calls);assert.equal((await p.command('trash.abandonSoftDelete',jobId)).state,'committed');assert.equal((await service.get(principal,project)).cleanupBlockedReason,null);}finally{await p.cleanup();}
});

test('upload inventory HTTP validates current login and project scope without exposing private source paths',async()=>{
  const p=await prepared();try{await p.seed();const app=new Hono().route('/api/projects',createStoredProjectUploadReadsRouter({port:p.port,service:p.make()})),url='/api/projects/'+project+'/uploads',headers={cookie:'relay_session=synthetic-upload-owner'};
    assert.equal((await app.request(url)).status,401);assert.equal((await app.request(url+'?path=elsewhere',{headers})).status,400);const response=await app.request(url,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal((await response.json() as any).files.length,1);const usage=await p.make().get(principal,project);assert.deepEqual(await(await app.request(url+'/usage',{headers})).json(),usage.usage);p.f.mutate(`UPDATE users SET disabled_at=1 WHERE id='${user}'`);assert.equal((await app.request(url,{headers})).status,401);
  }finally{await p.cleanup();}
});

test('inventory concurrency is bounded and close drains accepted reads without publishing stale results',async()=>{
  const p=await prepared(),entered=gate(),release=gate();let count=0;try{const service=p.make({readFiles:async(scope,activity)=>{if(++count===2)entered.resolve();await release.promise;return readUploadSnapshot(scope,activity);}}),first=service.get(principal,project),second=service.get(principal,project);await assert.rejects(service.get(principal,project),{code:'OVERLOADED'});await Promise.race([entered.promise,Promise.all([first,second]).then(()=>assert.fail('not entered'))]);const closing=service.close();release.resolve();await assert.rejects(first,{code:'CONFLICT'});await assert.rejects(second,{code:'CONFLICT'});await closing;await assert.rejects(service.get(principal,project),{code:'NOT_SUBMITTED'});
  }finally{release.resolve();await p.cleanup();}
});

test('real file activity ownership supplies reservations and blocks reads throughout physical publication',async()=>{
  const p=await prepared(),owner=new ProjectFileActivities(),entered=gate(),publish=gate(),publishing=gate(),release=gate();try{const draft=await p.seed({temporary:true}),scope=await p.port.readUploadScope({principal,projectId:project}),service=p.make({activity:value=>owner.snapshot(value)}),run=owner.withUpload(scope,{uploadId:randomUUID(),messageId:draft.messageId,size:50},async()=>{await p.port.readUploadScope({principal,projectId:project});},async({publish:commit})=>{entered.resolve();await publish.promise;await commit(async()=>{publishing.resolve();await release.promise;});});
    await Promise.race([entered.promise,run.then(()=>assert.fail('not entered'))]);assert.equal((await service.get(principal,project)).usage.reservedBytes,50);publish.resolve();await Promise.race([publishing.promise,run.then(()=>assert.fail('not publishing'))]);await assert.rejects(service.get(principal,project),{code:'CONFLICT'});release.resolve();await run;assert.equal((await service.get(principal,project)).usage.reservedBytes,0);
  }finally{publish.resolve();release.resolve();await owner.close();await p.cleanup();}
});

test('private incoming bytes count as quota after a restart without becoming public attachments',async()=>{
  const p=await prepared();try{const request={version:1 as const,jobId:randomUUID(),projectId:project,userId:user,messageId:randomUUID(),uploadId:randomUUID(),attachmentId:randomUUID(),name:'incoming.txt',mimeType:'text/plain',size:5,createdAt:1},body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(Buffer.from('hello'));controller.close();}});await new IncomingUploadJournal(p.root).receive(request,body,{signal:new AbortController().signal,mayStage:async()=>true});
    const service=p.make(),cold=await service.get(principal,project);assert.equal(cold.usage.usedBytes,5);assert.equal(cold.usage.reservedBytes,0);assert.deepEqual(cold.files,[]);p.state.activity={version:'receiving',reservations:[{uploadId:request.uploadId,messageId:request.messageId,size:5}]};const active=await service.get(principal,project);assert.equal(active.usage.usedBytes,0);assert.equal(active.usage.reservedBytes,5);assert.equal((await fs.readFile(path.join(p.root,'.relay_upload','.incoming',request.jobId,'payload.part'))).byteLength,5);
  }finally{await p.cleanup();}
});

test('permission changes during final activity IO cannot publish an attachment inventory',async()=>{
  const p=await prepared();let reads=0;try{await p.seed();const service=p.make({activity:async()=>{if(++reads===2)p.f.mutate(`UPDATE users SET disabled_at=1 WHERE id='${user}'`);return structuredClone(p.state.activity);}});await assert.rejects(service.get(principal,project),{code:'FORBIDDEN'});}finally{await p.cleanup();}
});
