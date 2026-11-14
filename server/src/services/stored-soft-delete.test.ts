import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { StoredSoftDelete } from './stored-soft-delete.js';
import { canonicalJson } from '../storage/command-boundary.js';
import { StoredTrash } from './stored-trash.js';

const project='11111111-1111-4111-8111-111111111111',a='22222222-2222-4222-8222-222222222222',b='33333333-3333-4333-8333-333333333333',old='44444444-4444-4444-8444-444444444444';
const actor={kind:'user' as const,userId:'owner',authSessionHash:'auth-owner'},maintenance={kind:'system' as const,purpose:'maintenance' as const};
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function prepared(){
  const f=fixture();f.mutate(`INSERT INTO projects(id,owner_user_id,path,name) VALUES('${project}','owner','D:/synthetic-soft-service','Synthetic');
    INSERT INTO sessions(id,owner_user_id,project_id,title,status,engine,engine_bound,codex_thread_id,engine_session_id,message_revision,deleted_at,codex_archived) VALUES
    ('${a}','owner','${project}','A','completed','codex',1,'thread-a','thread-a',1,NULL,0),
    ('${b}','owner','${project}','B','failed','codex',1,'thread-a','thread-a',1,NULL,0),
    ('${old}','owner','${project}','Old','stopped','codex',1,'thread-old','thread-old',1,7,1);
    INSERT INTO messages(id,session_id,role,content,created_at) VALUES('synthetic-msg','${a}','user','preserve body',1)`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'soft-service-test',generation:1,initialize:true});
  const state={archived:false as boolean|null,calls:0,reads:0,changes:0,closes:0};
  const instances:StoredSoftDelete[]=[];
  const make=(overrides:Partial<ConstructorParameters<typeof StoredSoftDelete>[0]>={},legacy=true)=>{
    const service=new StoredSoftDelete({port,storeId:'soft-service-test',generation:1,assertExclusiveWriter:async()=>{},
      isThreadArchived:async()=>{state.reads++;return state.archived;},
      archiveThread:async(_id,mayDispatch)=>{if(!await mayDispatch())throw new Error('FENCED');state.calls++;state.archived=true;},
      closeIdleConnection:async(_id,_thread,mayClose)=>{if(await mayClose())state.closes++;},changed:()=>{state.changes++;},...overrides});instances.push(service);
    if(legacy){
      // Existing tests exercise persisted jobs accepted by the former archive-before-delete flow.
      const remove=service.delete.bind(service),storage=overrides.port??port;
      service.delete=async(principal,intent,key)=>{
        if(principal.kind==='user'&&Object.keys(intent).sort().join(',')==='id,kind'&&/^[0-9a-f-]{36}$/i.test(key)){
          const h=createHash('sha256').update(canonicalJson(['soft-delete-job-v1',principal.userId,key.toLowerCase()])).digest('hex');
          const jobId=`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
          if(!await storage.readSoftDeleteJob({principal,jobId}))await storage.execute({protocolVersion:1,storeId:'soft-service-test',workerGeneration:1,requestId:randomUUID(),operationId:'legacy-seed:'+jobId,principal,
            command:{name:'trash.prepareSoftDelete',input:{jobId,kind:intent.kind,resourceId:intent.id}}});
        }
        return remove(principal,intent,key);
      };
    }
    return service;
  };
  const proxy=(overrides:Partial<CoreStoragePort>)=>new Proxy(port,{get(target,key){const value=Reflect.get(overrides,key)??Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as CoreStoragePort;
  const jobId=()=>f.scalar('SELECT id FROM _relay_soft_delete_jobs LIMIT 1') as string;
  const job=()=>port.readSoftDeleteJob({principal:maintenance,jobId:jobId()});
  const intent={kind:'project' as const,id:project};
  return{f,port,state,make,proxy,intent,jobId,job,cleanup:async()=>{await Promise.all(instances.map(s=>s.close()));await port.close();f.cleanup();}};
}

test('new local deletion commits without any Codex query or archive, retaining history and archive flags',async()=>{
  const p=await prepared();try{
    const service=p.make({isThreadArchived:async()=>{throw new Error('Codex offline');},archiveThread:async()=>{throw new Error('must not archive');}},false);
    const key=randomUUID();assert.deepEqual(await service.delete(actor,p.intent,key),{state:'committed'});
    assert.equal((await p.job())!.archives.length,0);assert.equal(p.state.reads,0);assert.equal(p.state.calls,0);
    assert.notEqual(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),null);
    assert.equal(p.f.scalar(`SELECT codex_archived FROM sessions WHERE id='${a}'`),0);
    assert.equal(p.f.scalar(`SELECT codex_archived_for_trash FROM sessions WHERE id='${a}'`),0);
    assert.equal(p.f.scalar("SELECT content FROM messages WHERE id='synthetic-msg'"),'preserve body');
    assert.deepEqual(await service.delete(actor,p.intent,key),{state:'committed'});
  }finally{await p.cleanup();}
});

test('new local deletion returns committed before optional notifications or idle cleanup finish',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{
    const service=p.make({changed:async()=>{entered.resolve();await release.promise;}},false);
    const run=service.delete(actor,p.intent,randomUUID());await entered.promise;
    assert.deepEqual(await run,{state:'committed'});assert.equal(p.state.closes,0);
    release.resolve();await service.close(); // Shutdown may discard optional idle cleanup after commit.
  }finally{release.resolve();await p.cleanup();}
});

test('restoring a new local deletion never unarchives Codex and prevents a late idle close',async()=>{
  const p=await prepared(),entered=gate(),release=gate(),finished=gate();let checks=0,closed=0;
  const trash=new StoredTrash({port:p.port,storeId:'soft-service-test',generation:1,verifyDirectory:async()=>{},
    unarchive:{run:async()=>{throw new Error('local restore must not call Codex');}},projectChanged:()=>{},sessionChanged:()=>{},sidebarChanged:()=>{}});
  try{
    const service=p.make({changed:async()=>{entered.resolve();await release.promise;},closeIdleConnection:async(_id,_thread,guard)=>{if(await guard())closed++;if(++checks===2)finished.resolve();}},false);
    const result=service.delete(actor,p.intent,randomUUID());await entered.promise;assert.equal((await result).state,'committed');
    assert.equal((await trash.restore(actor,'project',project,randomUUID())).state,'committed');
    release.resolve();await finished.promise;assert.equal(closed,0);
    assert.equal(p.f.scalar(`SELECT deleted_at FROM sessions WHERE id='${a}'`),null);
  }finally{release.resolve();await trash.close();await p.cleanup();}
});

async function cancellable(p:Awaited<ReturnType<typeof prepared>>,overrides:Partial<ConstructorParameters<typeof StoredSoftDelete>[0]>={}){
  const key=randomUUID(),port=p.proxy({execute:async(request:any)=>request.command.name==='trash.commitSoftDelete'?{state:'rejected',operationId:request.operationId,code:'CONFLICT'}:p.port.execute(request)} as any);
  const service=p.make({port,archiveThread:async(_thread,guard)=>{assert.equal(await guard(),true);p.state.calls++;p.state.archived=true;return{wasAlreadyArchived:false};},...overrides});
  assert.deepEqual(await service.delete(actor,p.intent,key),{state:'unknown'});return{key,service};
}

test('explicit cancellation compensates a settled attributable archive once and preserves all local history',async()=>{
  const p=await prepared();let restores=0;try{const {key,service}=await cancellable(p,{restoreThread:async(_thread,guard)=>{assert.equal(await guard(),true);restores++;p.state.archived=false;}});
    assert.deepEqual(await service.cancel(actor,p.intent,key),{state:'cancelled'});assert.equal(restores,1);assert.equal((await p.job())!.phase,'abandoned');assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),null);assert.equal(p.f.scalar(`SELECT deleted_at FROM sessions WHERE id='${old}'`),7);assert.equal(p.f.scalar("SELECT content FROM messages WHERE id='synthetic-msg'"),'preserve body');assert.deepEqual(await service.cancel(actor,p.intent,key),{state:'cancelled'});assert.equal(restores,1);
  }finally{await p.cleanup();}
});

test('maintenance may finish an explicit cancellation plan but never chooses cancellation from a deletion job',async()=>{
  const p=await prepared();let restores=0;try{const {key,service}=await cancellable(p);assert.deepEqual(await service.recoverCancellation(p.jobId()),{state:'unknown'});assert.equal((await p.job())!.phase,'prepared');assert.deepEqual(await service.cancel(actor,p.intent,key),{state:'unknown'});assert.equal((await p.job())!.phase,'cancelling');
    const recovery=p.make({restoreThread:async(_thread,guard)=>{assert.equal(await guard(),true);restores++;p.state.archived=false;}});assert.deepEqual(await recovery.recoverCancellation(p.jobId()),{state:'cancelled'});assert.equal(restores,1);
  }finally{await p.cleanup();}
});

test('observation-only archive attribution cannot authorize a compensation write',async()=>{
  const p=await prepared();let restores=0;try{const {key,service}=await cancellable(p,{archiveThread:async(_thread,guard)=>{assert.equal(await guard(),true);p.state.archived=true;},restoreThread:async()=>{restores++;}});assert.deepEqual(await service.cancel(actor,p.intent,key),{state:'unknown'});assert.equal((await p.job())!.phase,'prepared');assert.equal(restores,0);
  }finally{await p.cleanup();}
});

test('unknown restore claim never permits provider dispatch or repeated compensation on retry',async()=>{
  const p=await prepared();let restores=0;try{const {key}=await cancellable(p),port=p.proxy({execute:async(request:any)=>{const value=await p.port.execute(request);return request.command.name==='trash.claimTrashRestore'?{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'}:value;},lookup:async()=>{throw new Error('no receipt');}} as any),service=p.make({port,restoreThread:async()=>{restores++;}});
    assert.deepEqual(await service.cancel(actor,p.intent,key),{state:'unknown'});assert.equal((await p.job())!.compensations[0]!.phase,'dispatched');p.state.archived=false;assert.deepEqual(await service.cancel(actor,p.intent,key),{state:'unknown'});assert.equal(restores,0);assert.equal((await p.job())!.phase,'cancelling');
  }finally{await p.cleanup();}
});

test('a timed-out restore cannot dispatch late or be declared complete from target observation alone',async()=>{
  const p=await prepared(),entered=gate(),release=gate(),done=gate();let restores=0;try{const {key}=await cancellable(p),service=p.make({providerTimeoutMs:30,restoreThread:async(_thread,guard)=>{entered.resolve();await release.promise;if(await guard()){restores++;p.state.archived=false;}done.resolve();}}),run=service.cancel(actor,p.intent,key);await Promise.race([entered.promise,run.then(()=>assert.fail('not entered'))]);assert.deepEqual(await run,{state:'unknown'});release.resolve();await done.promise;assert.equal(restores,0);p.state.archived=false;assert.deepEqual(await service.recoverCancellation(p.jobId()),{state:'unknown'});assert.equal((await p.job())!.phase,'cancelling');
  }finally{release.resolve();await p.cleanup();}
});

test('lost compensation confirmation and finish replies are settled by durable job state',async()=>{
  const p=await prepared();let restores=0;try{const {key}=await cancellable(p),port=p.proxy({execute:async(request:any)=>{const result=await p.port.execute(request);return ['trash.confirmTrashRestore','trash.finishSoftDeleteCancel'].includes(request.command.name)?{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'}:result;},lookup:async()=>{throw new Error('offline');}} as any),service=p.make({port,restoreThread:async(_thread,guard)=>{assert.equal(await guard(),true);restores++;p.state.archived=false;}});
    assert.deepEqual(await service.cancel(actor,p.intent,key),{state:'cancelled'});assert.equal(restores,1);assert.equal((await p.job())!.phase,'abandoned');
  }finally{await p.cleanup();}
});

test('compensation rechecks source after provider setup before performing the restore RPC',async()=>{
  const p=await prepared();let restores=0;try{const {key,service}=await cancellable(p,{restoreThread:async(_thread,guard)=>{p.f.mutate(`UPDATE sessions SET updated_at=2 WHERE id='${a}'`);if(!await guard())throw new Error('FENCED');restores++;p.state.archived=false;}});assert.deepEqual(await service.cancel(actor,p.intent,key),{state:'unknown'});assert.equal(restores,0);assert.equal((await p.job())!.phase,'cancelling');assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),null);
  }finally{await p.cleanup();}
});

test('Native Worker coordination groups duplicate threads, preserves old trash and messages, and guards idle close',async()=>{
  const p=await prepared();try{const key=randomUUID(),service=p.make();
    assert.deepEqual(await service.delete(actor,p.intent,key),{state:'committed'});assert.equal(p.state.calls,1);assert.equal(p.state.closes,2);
    assert.equal(p.state.reads,2);assert.equal((await p.job())!.archives[0]!.evidence,'fresh-observation');
    assert.equal(p.f.scalar(`SELECT deleted_at FROM sessions WHERE id='${old}'`),7);assert.equal(p.f.scalar("SELECT content FROM messages WHERE id='synthetic-msg'"),'preserve body');
    assert.equal(p.f.scalar(`SELECT status FROM sessions WHERE id='${b}'`),'failed');
    assert.deepEqual(await p.make().delete(actor,p.intent,key),{state:'committed'});assert.equal(p.state.calls,1);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_soft_delete_jobs'),1);
  }finally{await p.cleanup();}
});
test('fresh pre-existing archive consumes no dispatch or restore responsibility',async()=>{
  const p=await prepared();try{p.state.archived=true;assert.deepEqual(await p.make().delete(actor,p.intent,randomUUID()),{state:'committed'});
    assert.equal(p.state.calls,0);assert.equal(p.f.scalar(`SELECT codex_archived_for_trash FROM sessions WHERE id='${a}'`),0);
  }finally{await p.cleanup();}
});
test('explicit provider evidence preserves its wasAlreadyArchived distinction',async()=>{
  for(const already of [true,false]){const p=await prepared();try{
    const service=p.make({archiveThread:async(_id,guard)=>{assert.equal(await guard(),true);p.state.calls++;return{wasAlreadyArchived:already};}});
    assert.deepEqual(await service.delete(actor,p.intent,randomUUID()),{state:'committed'});assert.equal(p.state.reads,1);
    assert.equal((await p.job())!.archives[0]!.evidence,'provider-reply');assert.equal(p.f.scalar(`SELECT codex_archived_for_trash FROM sessions WHERE id='${a}'`),Number(!already));
  }finally{await p.cleanup();}}
});
test('lost provider reply uses fresh positive proof and never repeats the archive',async()=>{
  const p=await prepared();try{const key=randomUUID();
    const service=p.make({archiveThread:async(_id,guard)=>{assert.equal(await guard(),true);p.state.calls++;p.state.archived=true;throw new Error('private lost reply');}});
    assert.deepEqual(await service.delete(actor,p.intent,key),{state:'committed'});assert.equal(p.state.calls,1);
    assert.equal((await p.job())!.archives[0]!.evidence,'fresh-observation');assert.deepEqual(await p.make().delete(actor,p.intent,key),{state:'committed'});assert.equal(p.state.calls,1);
  }finally{await p.cleanup();}
});
test('negative and unavailable reads preserve unknown dispatch; recovery cannot archive or commit',async()=>{
  const p=await prepared();try{const key=randomUUID();const service=p.make({archiveThread:async(_id,guard)=>{assert.equal(await guard(),true);p.state.calls++;throw new Error('ambiguous');}});
    assert.deepEqual(await service.delete(actor,p.intent,key),{state:'unknown'});assert.equal(p.state.calls,1);
    assert.deepEqual(await p.make().delete(actor,p.intent,key),{state:'unknown'});assert.equal(p.state.calls,1);
    p.state.archived=null;assert.deepEqual(await p.make().recover(p.jobId()),{state:'unknown'});assert.equal((await p.job())!.archives[0]!.phase,'dispatched');
    p.state.archived=true;assert.deepEqual(await p.make().recover(p.jobId()),{state:'unknown'});assert.equal((await p.job())!.archives[0]!.phase,'confirmed');
    assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),null);
    assert.deepEqual(await p.make().delete(actor,p.intent,key),{state:'committed'});assert.equal(p.state.calls,1);
  }finally{await p.cleanup();}
});
test('unknown claim without exact receipt cannot authorize a write, even if its durable phase advanced',async()=>{
  const p=await prepared();try{const key=randomUUID();
    const port=p.proxy({execute:async(request:any)=>{const result=await p.port.execute(request);return request.command.name==='trash.claimTrashArchive'?{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'}:result;},lookup:async()=>{throw new Error('no receipt');}} as any);
    assert.deepEqual(await p.make({port}).delete(actor,p.intent,key),{state:'unknown'});assert.equal(p.state.calls,0);assert.equal((await p.job())!.archives[0]!.phase,'dispatched');
    assert.deepEqual(await p.make().delete(actor,p.intent,key),{state:'unknown'});assert.equal(p.state.calls,0);
  }finally{await p.cleanup();}
});
test('registration and commit lost replies are settled from the private durable job',async()=>{
  const p=await prepared();try{
    const port=p.proxy({execute:async(request:any)=>{const result=await p.port.execute(request);return ['trash.prepareSoftDelete','trash.commitSoftDelete'].includes(request.command.name)?{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'}:result;},lookup:async()=>{throw new Error('unavailable');}} as any);
    assert.deepEqual(await p.make({port}).delete(actor,p.intent,randomUUID()),{state:'committed'});assert.equal(p.state.calls,1);
  }finally{await p.cleanup();}
});
test('current auth and source binding are rechecked after asynchronous provider setup',async()=>{
  for(const change of ["UPDATE users SET disabled_at=1 WHERE id='owner'",`UPDATE sessions SET codex_thread_id='newer',engine_session_id='newer' WHERE id='${a}'`]){
    const p=await prepared();try{const service=p.make({archiveThread:async(_id,guard)=>{p.f.mutate(change);await assert.rejects(async()=>{if(!await guard())throw new Error('FENCED');});}});
      assert.notEqual((await service.delete(actor,p.intent,randomUUID())).state,'committed');assert.equal(p.state.calls,0);assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),null);
    }finally{await p.cleanup();}
  }
});
test('provider timeout revokes a late continuation capability and never grants another dispatch',async()=>{
  const p=await prepared(),entered=gate(),release=gate(),finished=gate();let allowed:boolean|undefined;try{const key=randomUUID();
    const service=p.make({providerTimeoutMs:30,archiveThread:async(_id,guard)=>{entered.resolve();await release.promise;allowed=await guard();finished.resolve();}});
    const result=service.delete(actor,p.intent,key);await entered.promise;assert.deepEqual(await result,{state:'unknown'});release.resolve();await finished.promise;assert.equal(allowed,false);
    assert.deepEqual(await p.make().delete(actor,p.intent,key),{state:'unknown'});assert.equal(p.state.calls,0);
  }finally{release.resolve();await p.cleanup();}
});
test('shutdown during connection setup prevents write and local commit',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{
    const service=p.make({archiveThread:async(_id,guard)=>{entered.resolve();await release.promise;assert.equal(await guard(),false);}});
    const result=service.delete(actor,p.intent,randomUUID());await entered.promise;const closing=service.close();release.resolve();assert.deepEqual(await result,{state:'unknown'});await closing;
    await assert.rejects(service.delete(actor,p.intent,randomUUID()),{code:'NOT_SUBMITTED'});assert.equal(p.state.calls,0);
  }finally{release.resolve();await p.cleanup();}
});
test('concurrent instances share accepted work; conflicting intent cannot reuse its operation ID',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{const key=randomUUID();
    const first=p.make({archiveThread:async(_id,guard)=>{entered.resolve();await release.promise;if(await guard()){p.state.calls++;p.state.archived=true;}}});
    const run=first.delete(actor,p.intent,key);await entered.promise;const second=p.make().delete(actor,p.intent,key);
    assert.deepEqual(await p.make().delete(actor,{kind:'session',id:a},key),{state:'unknown'});release.resolve();assert.equal((await run).state,'committed');assert.equal((await second).state,'committed');assert.equal(p.state.calls,1);
    assert.deepEqual(await p.make().delete(actor,{kind:'session',id:a},key),{state:'rejected',code:'CONFLICT'});
  }finally{release.resolve();await p.cleanup();}
});
test('HTTP-facing timeout retains accepted ownership and a repeated key joins ongoing work',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{const key=randomUUID();
    const service=p.make({timeoutMs:20,archiveThread:async(_id,guard)=>{entered.resolve();await release.promise;if(await guard()){p.state.calls++;p.state.archived=true;}}});
    const run=service.delete(actor,p.intent,key);await entered.promise;assert.equal((await run).state,'unknown');const again=p.make().delete(actor,p.intent,key);release.resolve();assert.equal((await again).state,'committed');assert.equal(p.state.calls,1);
  }finally{release.resolve();await p.cleanup();}
});
test('initial unavailable observations leave dispatch prepared; maintenance has no registration or write authority',async()=>{
  const p=await prepared();try{p.state.archived=null;assert.equal((await p.make().delete(actor,p.intent,randomUUID())).state,'unknown');
    assert.equal((await p.job())!.archives[0]!.phase,'prepared');assert.equal((await p.make().recover(p.jobId())).state,'unknown');assert.equal(p.state.calls,0);
    assert.equal(p.f.scalar('SELECT count(*) FROM _relay_soft_delete_jobs'),1);assert.equal((await p.make().recover(randomUUID())).state,'unknown');
  }finally{await p.cleanup();}
});
test('strict arguments cannot submit maintenance principals, private scope, or malformed operation keys',async()=>{
  const p=await prepared();try{const service=p.make();
    for(const [principal,intent,key]of [[maintenance,p.intent,randomUUID()],[actor,{...p.intent,jobId:randomUUID()},randomUUID()],[actor,p.intent,'bad']] as any[])
      assert.deepEqual(await service.delete(principal,intent,key),{state:'rejected',code:'INVALID_ARGUMENT'});
    assert.equal(p.f.scalar('SELECT count(*) FROM _relay_soft_delete_jobs'),0);
  }finally{await p.cleanup();}
});
test('current close fence refuses restored, rebound, active, queued and foreign sessions',async()=>{
  const p=await prepared();try{assert.equal((await p.make().delete(actor,p.intent,randomUUID())).state,'committed');
    const check=()=>p.port.checkSoftDeleteClose({principal:actor,jobId:p.jobId(),sessionId:a,threadId:'thread-a'});assert.equal(await check(),true);
    for(const sql of [`UPDATE sessions SET deleted_at=NULL WHERE id='${a}'`,`UPDATE sessions SET deleted_at=1,codex_thread_id='other' WHERE id='${a}'`,
      `UPDATE sessions SET codex_thread_id='thread-a',status='processing' WHERE id='${a}'`,`UPDATE sessions SET status='completed',owner_user_id='other' WHERE id='${a}'`]){p.f.mutate(sql);assert.equal(await check(),false);}
    assert.equal(await p.port.checkSoftDeleteClose({principal:actor,jobId:p.jobId(),sessionId:old,threadId:'thread-old'}),false);
  }finally{await p.cleanup();}
});
test('a timed-out idle close cannot close a later runtime using its stale callback',async()=>{
  const p=await prepared(),entered=gate(),release=gate(),finished=gate();let allowed:boolean|undefined;try{
    const service=p.make({providerTimeoutMs:30,closeIdleConnection:async(id,_thread,guard)=>{if(id!==a)return;entered.resolve();await release.promise;allowed=await guard();finished.resolve();}});
    const run=service.delete(actor,p.intent,randomUUID());await entered.promise;assert.equal((await run).state,'committed');release.resolve();await finished.promise;assert.equal(allowed,false);
  }finally{release.resolve();await p.cleanup();}
});
test('non-Codex deletion and failed notifications never require provider writes or erase committed truth',async()=>{
  const p=await prepared();try{p.f.mutate(`UPDATE sessions SET engine='codebuddy',engine_bound=0,codex_thread_id=NULL,engine_session_id=NULL WHERE id IN ('${a}','${b}')`);
    assert.equal((await p.make({changed:()=>{throw new Error('unavailable');}}).delete(actor,p.intent,randomUUID())).state,'committed');assert.equal(p.state.calls,0);assert.equal(p.state.reads,0);
  }finally{await p.cleanup();}
});

test('cancellation releases only unused intent and permits a fresh operation after abandoning it',async()=>{
  const p=await prepared();try{const key=randomUUID(),service=p.make();p.state.archived=null;
    assert.equal((await service.delete(actor,p.intent,key)).state,'unknown');assert.equal((await service.cancel(actor,p.intent,key)).state,'cancelled');
    assert.equal((await p.job())!.phase,'abandoned');assert.equal((await service.cancel(actor,p.intent,key)).state,'cancelled');
    assert.equal((await service.delete(actor,p.intent,key)).state,'rejected');p.state.archived=false;
    assert.equal((await service.delete(actor,p.intent,randomUUID())).state,'committed');assert.equal(p.state.calls,1);
  }finally{await p.cleanup();}
});
test('cancellation cannot race accepted archive work, release an ambiguous dispatch or unarchive implicitly',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{const key=randomUUID();
    const service=p.make({archiveThread:async(_id,guard)=>{entered.resolve();await release.promise;assert.equal(await guard(),true);p.state.calls++;throw new Error('lost');}});
    const run=service.delete(actor,p.intent,key);await entered.promise;assert.equal((await p.make().cancel(actor,p.intent,key)).state,'unknown');release.resolve();assert.equal((await run).state,'unknown');
    assert.equal((await service.cancel(actor,p.intent,key)).state,'unknown');assert.equal((await p.job())!.phase,'prepared');assert.equal((await p.job())!.archives[0]!.phase,'dispatched');assert.equal(p.state.calls,1);
    p.state.archived=true;await service.recover(p.jobId());assert.equal((await service.cancel(actor,p.intent,key)).state,'unknown');assert.equal((await p.job())!.phase,'prepared');
  }finally{release.resolve();await p.cleanup();}
});
test('cancellation is currently authorized, target-bound and cannot undo a committed deletion',async()=>{
  const p=await prepared();try{const service=p.make(),key=randomUUID();p.state.archived=null;await service.delete(actor,p.intent,key);
    assert.deepEqual(await service.cancel(actor,{kind:'session',id:a},key),{state:'rejected',code:'CONFLICT'});
    p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");assert.deepEqual(await service.cancel(actor,p.intent,key),{state:'rejected',code:'FORBIDDEN'});
    p.f.mutate("UPDATE users SET disabled_at=NULL WHERE id='owner'");p.state.archived=false;assert.equal((await service.delete(actor,p.intent,key)).state,'committed');
    assert.deepEqual(await service.cancel(actor,p.intent,key),{state:'rejected',code:'CONFLICT'});
  }finally{await p.cleanup();}
});
