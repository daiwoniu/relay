import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import type { CoreStoragePort,StorageCommandEnvelope } from '../storage/contracts.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { hashSessionToken } from '../auth/session.js';
import { ProjectFileActivities } from '../uploads/project-file-activities.js';
import { StoredArchivedCleanup } from './stored-archived-cleanup.js';
import { createStoredArchivedCleanupRouter } from '../routes/stored-archived-cleanup.js';
const user='11111111-1111-4111-8111-111111111111',project='22222222-2222-4222-8222-222222222222';
const owner={kind:'user' as const,userId:user,authSessionHash:hashSessionToken('synthetic-archive-owner')},admin={kind:'user' as const,userId:'admin',authSessionHash:hashSessionToken('synthetic-archive-admin')},maintenance={kind:'system' as const,purpose:'maintenance' as const};
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
function proxy(port:StorageWorkerClient,hooks:{execute?:(input:StorageCommandEnvelope,invoke:()=>ReturnType<StorageWorkerClient['execute']>)=>ReturnType<StorageWorkerClient['execute']>;read?:(input:Parameters<CoreStoragePort['readUploadCleanupJob']>[0],invoke:()=>ReturnType<CoreStoragePort['readUploadCleanupJob']>)=>ReturnType<CoreStoragePort['readUploadCleanupJob']>}){
  return new Proxy(port,{get(target,key){if(key==='execute'&&hooks.execute)return(input:StorageCommandEnvelope)=>hooks.execute!(input,()=>target.execute(input));if(key==='readUploadCleanupJob'&&hooks.read)return(input:Parameters<CoreStoragePort['readUploadCleanupJob']>[0])=>hooks.read!(input,()=>target.readUploadCleanupJob(input));const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
}
async function prepared(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-stored-archive-')),f=fixture(),files=new ProjectFileActivities(),services:StoredArchivedCleanup[]=[],state={changes:0};
  f.mutate(`INSERT INTO users(id,role,username,must_change_password) VALUES('${user}','member','archive-owner',0);INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${owner.authSessionHash}','${user}',${Date.now()+600000});UPDATE auth_sessions SET token_hash='${admin.authSessionHash}' WHERE user_id='admin';INSERT INTO projects(id,owner_user_id,path,name) VALUES('${project}','${user}','${root.replaceAll("'","''")}','Uploads')`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'archive-service-test',generation:1,initialize:true});
  const make=(overrides:Partial<ConstructorParameters<typeof StoredArchivedCleanup>[0]>={})=>{const service=new StoredArchivedCleanup({port,storeId:'archive-service-test',generation:1,files,assertExclusiveWriter:async()=>{},changed:async()=>{state.changes++;},...overrides});services.push(service);return service;};
  const messageId=randomUUID(),directory=path.join(root,'.relay_upload','messages',messageId),entry=(name:string,size:number)=>({uploadId:randomUUID(),attachmentId:randomUUID(),name,storedName:name,size,mimeType:'text/plain',createdAt:1}),a=entry('first.txt',5),b=entry('second.txt',6),manifest={version:2,messageId,projectId:project,userId:user,createdAt:1,updatedAt:1,extra:'preserved',attachments:[a,b]},manifestPath=path.join(directory,'manifest.json');
  await fs.mkdir(directory,{recursive:true});await fs.writeFile(manifestPath,JSON.stringify(manifest));await fs.writeFile(path.join(directory,a.storedName),'hello');await fs.writeFile(path.join(directory,b.storedName),'second');
  const jobId=()=>String(f.scalar('SELECT id FROM _relay_upload_cleanup_jobs ORDER BY created_at LIMIT 1')),job=()=>port.readUploadCleanupJob({principal:maintenance,jobId:jobId()}),privatePath=()=>path.join(root,'.relay_upload','.cleanup',jobId(),messageId,a.attachmentId+'.payload');
  return{root,f,files,port,make,state,directory,a,b,manifest,manifestPath,jobId,job,privatePath,cleanup:async()=>{await Promise.all(services.map(service=>service.close()));await files.close();await port.close();f.cleanup();await fs.rm(root,{recursive:true,force:true});}};
}

test('actual Native and file journals complete selected cleanup once and preserve old-key scope',async()=>{
  const p=await prepared();try{const service=p.make(),key=randomUUID(),intent={projectId:project,attachmentIds:[p.a.attachmentId]},first=await service.delete(owner,intent,key);assert.equal(first.state,'committed');if(first.state!=='committed')return;assert.equal(first.cleanupPending,false);assert.equal(first.deletedCount,1);assert.equal(first.usage!.usedBytes,6);assert.equal((await p.job())!.filesFinished,true);await assert.rejects(fs.stat(p.privatePath()),{code:'ENOENT'});await assert.rejects(fs.stat(path.join(p.directory,p.a.storedName)),{code:'ENOENT'});
    assert.deepEqual(await service.delete(owner,intent,key),first);assert.equal((await service.delete(owner,{projectId:project,attachmentIds:[p.b.attachmentId]},key)).state,'rejected');assert.equal(await fs.readFile(path.join(p.directory,p.b.storedName),'utf8'),'second');assert.equal(p.f.scalar('SELECT count(*) FROM _relay_upload_cleanup_jobs'),1);
  }finally{await p.cleanup();}
});

test('unknown audited commit retains isolation, and an exact retry commits without duplicate audit effects',async()=>{
  const p=await prepared();try{p.f.mutate("CREATE TRIGGER fail_archive_commit BEFORE INSERT ON admin_audit_events WHEN NEW.result='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic'); END");const service=p.make(),key=randomUUID(),intent={projectId:project,attachmentIds:[p.a.attachmentId]};assert.equal((await service.delete(admin,intent,key)).state,'unknown');assert.equal((await p.job())!.phase,'prepared');assert.equal(await fs.readFile(p.privatePath(),'utf8'),'hello');p.f.mutate('DROP TRIGGER fail_archive_commit');const retried=await service.delete(admin,intent,key);assert.equal(retried.state,'committed');if(retried.state==='committed')assert.equal(retried.cleanupPending,false);assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='started'"),1);assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='succeeded'"),1);
  }finally{await p.cleanup();}
});

test('a positively rejected commit restores the exact files even after the submitting session expires',async()=>{
  const p=await prepared();try{const wrapped=proxy(p.port,{execute:async(input,invoke)=>{if(input.command.name==='uploadCleanup.commit')p.f.mutate(`UPDATE auth_sessions SET expires_at=1 WHERE token_hash='${owner.authSessionHash}'`);return invoke();}}),result=await p.make({port:wrapped}).delete(owner,{projectId:project,attachmentIds:[p.a.attachmentId]},randomUUID());assert.equal(result.state,'rejected');if(result.state==='rejected')assert.equal(result.rollbackPending,false);const job=(await p.job())!;assert.equal(job.phase,'rejected');assert.equal(job.filesFinished,true);assert.equal(await fs.readFile(path.join(p.directory,p.a.storedName),'utf8'),'hello');assert.deepEqual(JSON.parse(await fs.readFile(p.manifestPath,'utf8')),p.manifest);
  }finally{await p.cleanup();}
});

test('changed manifest leaves rollback pending and can resume only after the source is explicitly reconciled',async()=>{
  const p=await prepared();let changed=false;try{const wrapped=proxy(p.port,{read:async(input,invoke)=>{const job=await invoke();if(job&&!changed&&job.phase==='isolating'){try{await fs.stat(p.privatePath());changed=true;await fs.writeFile(p.manifestPath,JSON.stringify({...p.manifest,extra:'newer'}));}catch(error){if(!error||typeof error!=='object'||!('code'in error)||error.code!=='ENOENT')throw error;}}return job;}}),service=p.make({port:wrapped}),first=await service.delete(owner,{projectId:project,attachmentIds:[p.a.attachmentId]},randomUUID());assert.equal(changed,true);assert.equal(first.state,'rejected');if(first.state==='rejected')assert.equal(first.rollbackPending,true);assert.equal((await p.job())!.filesFinished,false);assert.equal(await fs.readFile(p.privatePath(),'utf8'),'hello');await assert.rejects(p.port.readUploadScope({principal:owner,projectId:project}),{code:'CONFLICT'});
    await fs.writeFile(p.manifestPath,JSON.stringify(p.manifest));const recovered=await service.recover(p.jobId());assert.equal(recovered.state,'rejected');if(recovered.state==='rejected')assert.equal(recovered.rollbackPending,false);assert.equal((await p.job())!.filesFinished,true);assert.equal(await fs.readFile(path.join(p.directory,p.a.storedName),'utf8'),'hello');assert.equal((await p.port.readUploadScope({principal:owner,projectId:project})).active,false);
  }finally{await p.cleanup();}
});

test('shutdown after known commit retains committed pending status until a new owner finishes physical cleanup',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{const wrapped=proxy(p.port,{execute:async(input,invoke)=>{const result=await invoke();if(input.command.name==='uploadCleanup.commit'&&result.state==='committed'){entered.resolve();await release.promise;}return result;}}),service=p.make({port:wrapped}),run=service.delete(owner,{projectId:project,attachmentIds:[p.a.attachmentId]},randomUUID());await entered.promise;const closing=service.close();release.resolve();const result=await run;await closing;assert.equal(result.state,'committed');if(result.state==='committed')assert.equal(result.cleanupPending,true);assert.equal((await p.job())!.phase,'committed');assert.equal(await fs.readFile(p.privatePath(),'utf8'),'hello');const recovered=await p.make().recover(p.jobId());assert.equal(recovered.state,'committed');if(recovered.state==='committed')assert.equal(recovered.cleanupPending,false);assert.equal((await p.job())!.filesFinished,true);await assert.rejects(fs.stat(p.privatePath()),{code:'ENOENT'});
  }finally{release.resolve();await p.cleanup();}
});

test('overlapping identical requests share the physical owner while a second cleanup key is fenced',async()=>{
  const p=await prepared(),entered=gate(),release=gate();let commits=0;try{const wrapped=proxy(p.port,{execute:async(input,invoke)=>{const result=await invoke();if(input.command.name==='uploadCleanup.commit'){commits++;entered.resolve();await release.promise;}return result;}}),service=p.make({port:wrapped}),key=randomUUID(),intent={projectId:project,attachmentIds:[p.a.attachmentId]},first=service.delete(owner,intent,key);await entered.promise;const same=p.make({port:wrapped}).delete(owner,intent,key);assert.equal(first,same);const competing=await service.delete(owner,intent,randomUUID());assert.equal(competing.state,'rejected');release.resolve();const result=await first;assert.equal(result.state,'committed');assert.deepEqual(await same,result);assert.equal(commits,1);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_upload_cleanup_jobs'),1);
  }finally{release.resolve();await p.cleanup();}
});

test('maintenance releases a known unstarted task without needing the missing project directory',async()=>{
  const p=await prepared();try{const missing=path.join(p.root,'missing'),jobId=randomUUID();p.f.mutate(`UPDATE projects SET path='${missing.replaceAll("'","''")}' WHERE id='${project}'`);assert.equal((await p.port.execute({protocolVersion:1,storeId:'archive-service-test',workerGeneration:1,requestId:randomUUID(),operationId:randomUUID(),principal:owner,command:{name:'uploadCleanup.prepare',input:{jobId,projectId:project,attachmentIds:null}}})).state,'committed');const result=await p.make().recover(jobId);assert.equal(result.state,'rejected');if(result.state==='rejected')assert.equal(result.rollbackPending,false);assert.equal((await p.port.readUploadCleanupJob({principal:maintenance,jobId}))!.filesFinished,true);await assert.rejects(fs.stat(missing),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(p.directory,p.a.storedName),'utf8'),'hello');}finally{await p.cleanup();}
});

test('candidate cleanup HTTP validates stable operation, bounded body and pending outcomes',async()=>{
  const p=await prepared();try{const app=new Hono().route('/api/projects',createStoredArchivedCleanupRouter({port:p.port,service:p.make(),bodyTimeoutMs:25})),base=`/api/projects/${project}/uploads`,headers={cookie:'relay_session=synthetic-archive-owner','x-relay-operation-id':randomUUID()};
    assert.equal((await app.request(base,{method:'DELETE'})).status,401);assert.equal((await app.request(base,{method:'DELETE',headers:{cookie:headers.cookie}})).status,400);assert.equal((await app.request(base,{method:'DELETE',headers:{...headers,origin:'https://hostile.invalid'}})).status,403);assert.equal((await app.request(base+'?force=1',{method:'DELETE',headers})).status,400);assert.equal((await app.request(base+'/delete',{method:'POST',headers,body:'x'.repeat(4097)})).status,413);assert.equal((await app.request(base+'/delete',{method:'POST',headers,body:JSON.stringify({attachmentIds:[p.a.attachmentId,p.a.attachmentId]})})).status,400);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_upload_cleanup_jobs'),0);
    const response=await app.request(base+'/'+p.a.attachmentId,{method:'DELETE',headers});assert.equal(response.status,200);assert.equal(response.headers.get('x-relay-operation-id'),headers['x-relay-operation-id']);assert.equal(response.headers.get('cache-control'),'private, no-store');const value=await response.json() as any;assert.equal(value.deletedCount,1);assert.equal(value.usage.usedBytes,6);
    const all=await app.request(base,{method:'DELETE',headers:{...headers,'x-relay-operation-id':randomUUID()}});assert.equal(all.status,200);assert.equal((await all.json() as any).usage.usedBytes,0);
    const pendingApp=new Hono().route('/api/projects',createStoredArchivedCleanupRouter({port:p.port,service:{delete:async()=>({state:'committed',deletedCount:1,cleanupPending:true,usage:null})}})),pending=await pendingApp.request(base,{method:'DELETE',headers});assert.equal(pending.status,202);assert.deepEqual(await pending.json(),{state:'committed',deletedCount:1,cleanupPending:true,usagePending:true});
  }finally{await p.cleanup();}
});

test('a stalled cleanup JSON body is cancelled before any Native job or file dispatch',async()=>{
  const p=await prepared();let cancelled=false;try{const app=new Hono().route('/api/projects',createStoredArchivedCleanupRouter({port:p.port,service:p.make(),bodyTimeoutMs:20})),body=new ReadableStream<Uint8Array>({pull(){return new Promise<void>(()=>{});},cancel(){cancelled=true;}}),request=new Request(`http://localhost/api/projects/${project}/uploads/delete`,{method:'POST',headers:{cookie:'relay_session=synthetic-archive-owner','x-relay-operation-id':randomUUID()},body,duplex:'half'} as RequestInit);const response=await app.request(request);assert.equal(response.status,503);assert.equal(cancelled,true);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_upload_cleanup_jobs'),0);assert.equal(await fs.readFile(path.join(p.directory,p.a.storedName),'utf8'),'hello');
  }finally{await p.cleanup();}
});

test('a delayed exclusive-writer reply cannot dispatch a new Native intent after service close',async()=>{
  const p=await prepared(),entered=gate(),release=gate();let blocked=false;try{const scope=await p.port.readUploadScope({principal:owner,projectId:project}),service=p.make({assertExclusiveWriter:async()=>{if(blocked)return;try{await p.files.snapshot(scope);}catch(error){if(!(error instanceof StorageContractError)||error.code!=='CONFLICT')throw error;blocked=true;entered.resolve();await release.promise;}}}),run=service.delete(owner,{projectId:project,attachmentIds:[p.a.attachmentId]},randomUUID());await entered.promise;let closed=false;const closing=service.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_upload_cleanup_jobs'),0);release.resolve();assert.notEqual((await run).state,'committed');await closing;assert.equal(p.f.scalar('SELECT count(*) FROM _relay_upload_cleanup_jobs'),0);assert.equal(await fs.readFile(path.join(p.directory,p.a.storedName),'utf8'),'hello');
  }finally{release.resolve();await p.cleanup();}
});

test('post-commit permission loss is an access failure without changing the committed business fact',async()=>{
  const p=await prepared();try{const service=p.make({changed:async()=>{p.f.mutate(`UPDATE users SET disabled_at=1 WHERE id='${user}'`);}}),result=await service.delete(owner,{projectId:project,attachmentIds:[p.a.attachmentId]},randomUUID());assert.deepEqual(result,{state:'access-denied',code:'FORBIDDEN'});assert.equal((await p.job())!.phase,'committed');assert.equal((await p.job())!.filesFinished,true);await assert.rejects(fs.stat(path.join(p.directory,p.a.storedName)),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(p.directory,p.b.storedName),'utf8'),'second');
  }finally{await p.cleanup();}
});

test('an authorized admin file-stage rejection records one failed audit and restores scope without deleting data',async()=>{
  const p=await prepared();try{await fs.writeFile(p.manifestPath,'{corrupt');const result=await p.make().delete(admin,{projectId:project,attachmentIds:null},randomUUID());assert.equal(result.state,'rejected');if(result.state==='rejected')assert.equal(result.rollbackPending,false);assert.equal((await p.job())!.phase,'rejected');assert.equal((await p.job())!.filesFinished,true);assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='started'"),1);assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='failed'"),1);assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='succeeded'"),0);assert.equal(await fs.readFile(path.join(p.directory,p.a.storedName),'utf8'),'hello');assert.equal(await fs.readFile(p.manifestPath,'utf8'),'{corrupt');
  }finally{await p.cleanup();}
});
