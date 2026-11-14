import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import type { CoreStoragePort,StorageCommandEnvelope } from '../storage/contracts.js';
import { ProjectUploadStore } from '../uploads/project-uploads.js';
import { StoredPurge,type PurgeIntent } from './stored-purge.js';

const project='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222',session='33333333-3333-4333-8333-333333333333';
const admin={kind:'user' as const,userId:'admin',authSessionHash:'auth-admin'},maintenance={kind:'system' as const,purpose:'maintenance' as const};
async function exists(filename:string){try{await fs.lstat(filename);return true;}catch(e){if(e&&typeof e==='object'&&'code'in e&&e.code==='ENOENT')return false;throw e;}}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function prepared(count=1){
  const f=fixture(),root=path.join(f.directory,'synthetic-project');await fs.mkdir(root);const real=await fs.realpath(root),store=new ProjectUploadStore();
  const messages:Array<{id:string;file:string;metadata:string}>=[];
  for(let i=0;i<count;i++){
    const id=randomUUID(),draft=await store.writeUpload({projectId:project,projectPath:real,userId:owner,messageId:id,uploadId:randomUUID(),name:`payload-${i}.txt`,mimeType:'text/plain',declaredSize:4,
      body:(async function*(){yield Buffer.from('DATA');})()});
    const archived=store.prepareArchive({projectPath:real,projectId:project,userId:owner,messageId:id,drafts:[draft]});messages.push({id,file:archived.attachments[0]!.path,metadata:JSON.stringify({attachments:archived.attachments})});
  }
  await fs.writeFile(path.join(real,'user-source.txt'),'preserve source');
  f.mutate(`INSERT INTO users(id,role,username) VALUES('${owner}','member','synthetic-owner');
    INSERT INTO projects(id,owner_user_id,path,name,deleted_at) VALUES('${project}','${owner}','unused','Synthetic project',1);
    INSERT INTO sessions(id,owner_user_id,project_id,title,status,engine,message_revision,deleted_at) VALUES('${session}','${owner}','${project}','Synthetic session','completed','codex',1,1)`);
  const db=new DatabaseSync(f.filename);try{db.prepare('UPDATE projects SET path=? WHERE id=?').run(real,project);
    for(const message of messages)db.prepare('INSERT INTO messages(id,session_id,turn_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?)').run(message.id,session,'turn','user','synthetic',message.metadata,1);
  }finally{db.close();}
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const impact=await port.readTrash({principal:admin,name:'impact',input:{kind:'project',id:project}});
  const intent:PurgeIntent={kind:'project',id:project,impactRevision:impact.impactRevision,confirmationName:'Synthetic project'};
  let changes=0;const instances:StoredPurge[]=[];
  const proxy=(overrides:Partial<CoreStoragePort>)=>new Proxy(port,{get(target,key){const override=Reflect.get(overrides,key);if(override!==undefined)return override;
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as CoreStoragePort;
  const make=(overrides:Partial<ConstructorParameters<typeof StoredPurge>[0]>={})=>{const service=new StoredPurge({port,storeId:'store',generation:1,assertExclusiveWriter:async()=>{},changed:()=>{changes++;},...overrides});instances.push(service);return service;};
  const jobId=()=>f.scalar('SELECT id FROM _relay_purge_jobs LIMIT 1') as string;
  const job=async()=>port.readPurgeJob({principal:maintenance,jobId:jobId()});
  return{f,root:real,messages,port,intent,make,proxy,jobId,job,changes:()=>changes,cleanup:async()=>{await Promise.all(instances.map(s=>s.close()));await port.close();f.cleanup();}};
}
test('real Native Worker and upload archives complete one atomic deletion and exact-file cleanup',async()=>{
  const p=await prepared(2);try{const key=randomUUID(),service=p.make();
    assert.deepEqual(await service.delete(admin,p.intent,key),{state:'committed',cleanupPending:false});
    assert.equal(p.f.scalar(`SELECT count(*) FROM projects WHERE id='${project}'`),0);assert.equal((await p.job())!.filesFinished,true);
    for(const message of p.messages)assert.equal(await exists(message.file),false);
    assert.equal(await fs.readFile(path.join(p.root,'user-source.txt'),'utf8'),'preserve source');
    assert.deepEqual(await p.make().delete(admin,p.intent,key),{state:'committed',cleanupPending:false});
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE action='project.permanent_delete' AND result='succeeded'"),1);
    assert.equal(p.f.scalar('SELECT count(*) FROM _relay_purge_jobs'),1);
  }finally{await p.cleanup();}
});
test('empty attachment plans never create upload directories or require a filesystem round trip',async()=>{
  const p=await prepared(0);try{
    assert.deepEqual(await p.make().delete(admin,p.intent,randomUUID()),{state:'committed',cleanupPending:false});
    const job=(await p.job())!;assert.equal(job.filesStarted,false);assert.equal(job.filesFinished,true);assert.match(job.intentDigest!,/^[a-f0-9]{64}$/);
    assert.equal(await exists(path.join(p.root,'.relay_upload')),false);assert.equal(await fs.readFile(path.join(p.root,'user-source.txt'),'utf8'),'preserve source');
  }finally{await p.cleanup();}
});
test('prefetched impacts allow sequential deletion of two sibling sessions with managed attachments',async()=>{
  const p=await prepared(2),sibling=randomUUID();
  try{
    p.f.mutate(`UPDATE projects SET deleted_at=NULL WHERE id='${project}';
      INSERT INTO sessions(id,owner_user_id,project_id,title,status,engine,message_revision,deleted_at)
      VALUES('${sibling}','${owner}','${project}','Sibling','completed','codex',1,1);
      UPDATE messages SET session_id='${sibling}' WHERE id='${p.messages[1]!.id}'`);
    const intents:PurgeIntent[]=[];
    for(const id of [session,sibling]){
      const impact=await p.port.readTrash({principal:admin,name:'impact',input:{kind:'session',id}});
      intents.push({kind:'session',id,impactRevision:impact.impactRevision,confirmationName:null});
    }
    const service=p.make();
    for(const intent of intents)assert.deepEqual(await service.delete(admin,intent,randomUUID()),{state:'committed',cleanupPending:false});
    assert.equal(p.f.scalar(`SELECT count(*) FROM sessions WHERE project_id='${project}'`),0);
    assert.equal(p.f.scalar(`SELECT count(*) FROM projects WHERE id='${project}'`),1);
  }finally{await p.cleanup();}
});

test('lost commit and proof replies recover from durable task state even when exact receipt lookup is unavailable',async()=>{
  const p=await prepared();try{let commits=0;
    const port=p.proxy({execute:async(request:any)=>{const result=await p.port.execute(request);if(request.command.name==='trash.commitPurge')commits++;
      return ['trash.bindPurgeProof','trash.commitPurge'].includes(request.command.name)&&result.state==='committed'?{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'}:result;},lookup:async()=>{throw new Error('synthetic unavailable');}} as any);
    assert.deepEqual(await p.make({port}).delete(admin,p.intent,randomUUID()),{state:'committed',cleanupPending:false});assert.equal(commits,1);
    assert.equal(await exists(p.messages[0]!.file),false);
  }finally{await p.cleanup();}
});
test('unknown registration with an unreadable task performs no file action; maintenance only rejects it',async()=>{
  const p=await prepared();try{let registered=false,hideOnce=true;
    const port=p.proxy({execute:async(request:any)=>{const result=await p.port.execute(request);if(request.command.name==='trash.preparePurge'){registered=true;return{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'};}return result;},
      lookup:async()=>{throw new Error('synthetic unavailable');},readPurgeJob:async(request:any)=>{if(registered&&hideOnce){hideOnce=false;return null;}return p.port.readPurgeJob(request);}} as any);
    assert.deepEqual(await p.make({port}).delete(admin,p.intent,randomUUID()),{state:'unknown'});assert.equal(await exists(p.messages[0]!.file),true);assert.equal((await p.job())!.phase,'reserved');
    assert.equal((await p.make().recover(p.jobId())).state,'rejected');assert.equal((await p.job())!.filesFinished,true);assert.equal(await exists(p.messages[0]!.file),true);
  }finally{await p.cleanup();}
});
test('maintenance resolves a dispatched job with no intent without moving or parsing original files',async()=>{
  const p=await prepared();try{
    const jobId=randomUUID(),request=(name:string,input:any):StorageCommandEnvelope=>({protocolVersion:1,storeId:'store',workerGeneration:1,requestId:randomUUID(),operationId:randomUUID(),principal:admin,command:{name,input} as any});
    await p.port.execute(request('trash.preparePurge',{jobId,kind:'project',resourceId:project,impactRevision:p.intent.impactRevision,confirmationName:p.intent.confirmationName}));
    await p.port.execute(request('trash.startPurgeFiles',{jobId}));
    const manifest=path.join(path.dirname(p.messages[0]!.file),'manifest.json');await fs.writeFile(manifest,'broken original metadata');
    assert.equal((await p.make().recover(jobId)).state,'rejected');assert.equal((await p.job())!.filesFinished,true);
    assert.equal(await fs.readFile(manifest,'utf8'),'broken original metadata');assert.equal(await fs.readFile(p.messages[0]!.file,'utf8'),'DATA');
    assert.equal(p.f.scalar(`SELECT count(*) FROM projects WHERE id='${project}'`),1);
  }finally{await p.cleanup();}
});
test('malformed managed manifest rejects safely and clears the no-move task without deleting content',async()=>{
  const p=await prepared();try{
    await fs.writeFile(path.join(path.dirname(p.messages[0]!.file),'manifest.json'),'invalid manifest');
    const outcome=await p.make().delete(admin,p.intent,randomUUID());assert.equal(outcome.state,'rejected');assert.equal((await p.job())!.filesFinished,true);
    assert.equal(await fs.readFile(p.messages[0]!.file,'utf8'),'DATA');assert.equal(p.f.scalar(`SELECT count(*) FROM projects WHERE id='${project}'`),1);
  }finally{await p.cleanup();}
});
test('partial quarantine error durably rejects then restores every moved archive',async()=>{
  const p=await prepared(2);try{let interrupted=false;
    const outcome=await p.make({assertExclusiveWriter:async()=>{if(!interrupted&&(await Promise.all(p.messages.map(m=>exists(m.file)))).some(v=>!v)){interrupted=true;throw new Error('synthetic interrupted writer');}}}).delete(admin,p.intent,randomUUID());
    assert.equal(outcome.state,'rejected');assert.equal(interrupted,true);assert.equal((await p.job())!.phase,'rejected');assert.equal((await p.job())!.filesFinished,true);
    for(const message of p.messages)assert.equal(await fs.readFile(message.file,'utf8'),'DATA');
    assert.equal(p.f.scalar(`SELECT count(*) FROM projects WHERE id='${project}'`),1);
  }finally{await p.cleanup();}
});
test('unknown commit rollback keeps isolated files until maintenance durably rejects the unfinished job',async()=>{
  const p=await prepared();try{
    p.f.mutate("CREATE TRIGGER reject_commit BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='trash.commitPurge' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    assert.deepEqual(await p.make().delete(admin,p.intent,randomUUID()),{state:'unknown'});assert.equal((await p.job())!.phase,'prepared');assert.equal(await exists(p.messages[0]!.file),false);
    assert.equal(p.f.scalar(`SELECT count(*) FROM projects WHERE id='${project}'`),1);
    assert.equal((await p.make().recover(p.jobId())).state,'rejected');assert.equal(await fs.readFile(p.messages[0]!.file,'utf8'),'DATA');
  }finally{await p.cleanup();}
});
test('losing admin authority after file isolation rejects and restores without committing deletion',async()=>{
  const p=await prepared();try{
    const port=p.proxy({execute:async(request:any)=>{if(request.command.name==='trash.bindPurgeProof'&&request.principal.kind==='user')p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");return p.port.execute(request);}} as any);
    const result=await p.make({port}).delete(admin,p.intent,randomUUID());assert.equal(result.state,'rejected');
    assert.equal((await p.job())!.phase,'rejected');assert.equal((await p.job())!.filesFinished,true);assert.equal(await fs.readFile(p.messages[0]!.file,'utf8'),'DATA');
  }finally{await p.cleanup();}
});
test('known commit stays committed when the following projection is unavailable; maintenance resumes only cleanup',async()=>{
  const p=await prepared();try{let committed=false;
    const port=p.proxy({execute:async(request:any)=>{const result=await p.port.execute(request);if(request.command.name==='trash.commitPurge'&&result.state==='committed')committed=true;return result;},
      readPurgeJob:async(request:any)=>{if(committed)throw new Error('synthetic unavailable');return p.port.readPurgeJob(request);}} as any);
    assert.deepEqual(await p.make({port}).delete(admin,p.intent,randomUUID()),{state:'committed',cleanupPending:true});
    assert.equal((await p.job())!.phase,'committed');assert.equal(await exists(p.messages[0]!.file),false);
    assert.deepEqual(await p.make().recover(p.jobId()),{state:'committed',cleanupPending:false});assert.equal((await p.job())!.filesFinished,true);
  }finally{await p.cleanup();}
});
test('ambiguous commit plus unavailable task read remains unknown and never rolls back a committed deletion',async()=>{
  const p=await prepared();try{let committed=false;
    const port=p.proxy({execute:async(request:any)=>{const result=await p.port.execute(request);if(request.command.name==='trash.commitPurge'&&result.state==='committed'){
      committed=true;return{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'};}return result;},
      lookup:async()=>{throw new Error('synthetic unavailable');},readPurgeJob:async(request:any)=>{if(committed)throw new Error('synthetic unavailable');return p.port.readPurgeJob(request);}} as any);
    assert.deepEqual(await p.make({port}).delete(admin,p.intent,randomUUID()),{state:'unknown'});assert.equal((await p.job())!.phase,'committed');assert.equal(await exists(p.messages[0]!.file),false);
    assert.deepEqual(await p.make().recover(p.jobId()),{state:'committed',cleanupPending:false});assert.equal(p.f.scalar(`SELECT count(*) FROM projects WHERE id='${project}'`),0);
  }finally{await p.cleanup();}
});
test('tampered quarantine content leaves a visible committed cleanup task and is never rolled back or silently removed',async()=>{
  const p=await prepared();try{let filename='';
    const port=p.proxy({execute:async(request:any)=>{const result=await p.port.execute(request);if(request.command.name==='trash.commitPurge'&&result.state==='committed'){
      filename=path.join(p.root,'.relay_upload','.trash-quarantine',request.command.input.jobId,p.messages[0]!.id,path.basename(p.messages[0]!.file));await fs.writeFile(filename,'TAMPERED');}return result;}} as any);
    assert.deepEqual(await p.make({port}).delete(admin,p.intent,randomUUID()),{state:'committed',cleanupPending:true});
    assert.equal((await p.job())!.filesFinished,false);assert.equal(await fs.readFile(filename,'utf8'),'TAMPERED');
    assert.deepEqual(await p.make().recover(p.jobId()),{state:'committed',cleanupPending:true});assert.equal(await fs.readFile(filename,'utf8'),'TAMPERED');
    assert.equal(await exists(p.messages[0]!.file),false);assert.equal(p.f.scalar(`SELECT count(*) FROM projects WHERE id='${project}'`),0);
  }finally{await p.cleanup();}
});
test('lost file-finish replies recover from final task state and old business intent remains checked after receipt expiry',async()=>{
  const p=await prepared();try{const key=randomUUID();
    const port=p.proxy({execute:async(request:any)=>{const result=await p.port.execute(request);return request.command.name==='trash.finishPurgeFiles'&&result.state==='committed'
      ?{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'}:result;},lookup:async()=>{throw new Error('synthetic unavailable');}} as any);
    assert.deepEqual(await p.make({port}).delete(admin,p.intent,key),{state:'committed',cleanupPending:false});
    p.f.mutate('UPDATE _relay_storage_operations SET expired=1,result_json=NULL');
    assert.deepEqual(await p.make().delete(admin,p.intent,key),{state:'committed',cleanupPending:false});
    assert.deepEqual(await p.make().delete(admin,{...p.intent,confirmationName:'changed confirmation'},key),{state:'rejected',code:'CONFLICT'});
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE action='project.permanent_delete' AND result='succeeded'"),1);
  }finally{await p.cleanup();}
});
test('HTTP deadlines keep accepted work owned; another coordinator cannot recover it concurrently and close drains it',async()=>{
  const p=await prepared();const entered=deferred(),gate=deferred();let released=false;
  const keepAlive=setTimeout(()=>gate.resolve(),5000);
  try{const port=p.proxy({execute:async(request:any)=>{const result=await p.port.execute(request);if(request.command.name==='trash.startPurgeFiles'){entered.resolve();await gate.promise;}return result;}} as any);
    const service=p.make({port,timeoutMs:10}),key=randomUUID(),run=service.delete(admin,p.intent,key);await entered.promise;
    assert.deepEqual(await run,{state:'unknown'});assert.deepEqual(await p.make().recover(p.jobId()),{state:'unknown'});
    let closed=false;const closing=service.close().then(()=>{closed=true;});await new Promise(r=>setTimeout(r,5));assert.equal(closed,false);
    gate.resolve();released=true;await closing;assert.deepEqual(await p.make().delete(admin,p.intent,key),{state:'committed',cleanupPending:false});
    await assert.rejects(service.recover(p.jobId()),{code:'NOT_SUBMITTED'});
  }finally{clearTimeout(keepAlive);if(!released)gate.resolve();await p.cleanup();}
});
test('a deadline after confirmed DB commit preserves the committed outcome while cleanup is still pending',async()=>{
  const p=await prepared(),entered=deferred(),gate=deferred();let committed=false,blocked=false;
  const keepAlive=setTimeout(()=>gate.resolve(),5000);
  try{const port=p.proxy({execute:async(request:any)=>{const result=await p.port.execute(request);if(request.command.name==='trash.commitPurge'&&result.state==='committed')committed=true;return result;},
      readPurgeJob:async(request:any)=>{if(committed&&!blocked){blocked=true;entered.resolve();await gate.promise;}return p.port.readPurgeJob(request);}} as any);
    const service=p.make({port,timeoutMs:25}),key=randomUUID(),run=service.delete(admin,p.intent,key);await entered.promise;await run;
    // Start the observed deadline after the commit barrier, independent of machine speed before commit.
    assert.deepEqual(await service.delete(admin,p.intent,key),{state:'committed',cleanupPending:true});gate.resolve();await service.close();
    assert.deepEqual(await p.make().recover(p.jobId()),{state:'committed',cleanupPending:false});
  }finally{clearTimeout(keepAlive);gate.resolve();await p.cleanup();}
});
