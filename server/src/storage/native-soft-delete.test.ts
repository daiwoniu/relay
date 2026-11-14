import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './storage-fixture.test-support.js';
import { NativeStore } from './native-store.js';
import { StorageWorkerClient } from './worker-client.js';
import { parseCommandEnvelope } from './command-boundary.js';
import type { CoreCommand,StorageCommandEnvelope,StoragePrincipal,SoftDeleteJob } from './contracts.js';
const project='11111111-1111-4111-8111-111111111111',a='22222222-2222-4222-8222-222222222222',a2='33333333-3333-4333-8333-333333333333',b='44444444-4444-4444-8444-444444444444';
const old='55555555-5555-4555-8555-555555555555',plain='66666666-6666-4666-8666-666666666666',sibling='77777777-7777-4777-8777-777777777777',share='88888888-8888-4888-8888-888888888888';
const owner={kind:'user' as const,userId:'owner',authSessionHash:'auth-owner'},admin={kind:'user' as const,userId:'admin',authSessionHash:'auth-admin'},maintenance={kind:'system' as const,purpose:'maintenance' as const};
function envelope(command:CoreCommand,key:string=randomUUID(),principal:StoragePrincipal=owner):StorageCommandEnvelope{return{protocolVersion:1,storeId:'store',workerGeneration:1,requestId:randomUUID(),operationId:key,principal,command};}
function prepared(){
  const f=fixture();f.mutate(`INSERT INTO projects(id,owner_user_id,path,name) VALUES('${project}','owner','D:/synthetic-soft','Soft project');
    INSERT INTO sessions(id,owner_user_id,project_id,title,status,engine,engine_bound,codex_thread_id,engine_session_id,message_revision,deleted_at,codex_archived,codex_archived_for_trash) VALUES
      ('${a}','owner','${project}','A','completed','codex',1,'new-thread','new-thread',1,NULL,0,0),('${a2}','owner','${project}','A duplicate','completed','codex',1,'new-thread','new-thread',1,NULL,0,0),
      ('${b}','owner','${project}','B','stopped','codex',1,'already-thread','already-thread',1,NULL,1,0),('${old}','owner','${project}','Old trash','failed','codex',1,'old-thread','old-thread',1,7,1,1),
      ('${plain}','owner','${project}','Plain','failed','codebuddy',1,NULL,NULL,1,NULL,0,0),('${sibling}','owner','project','Sibling','completed','codex',1,'sibling-thread','sibling-thread',1,NULL,0,0);
    INSERT INTO messages(id,session_id,role,content,created_at) VALUES('soft-message','${a}','user','preserved',1);
    INSERT INTO shared_records VALUES('${share}','${'a'.repeat(64)}','owner','${a}','Snapshot','session',1,0,1,'{"version":1}',1,NULL,NULL);
    INSERT INTO sidebar_order_items VALUES('main','project','${project}',0),('project:${project}','session','${a}',0);
    INSERT INTO sidebar_order_scopes VALUES('project:${project}',1);`);
  const store=new NativeStore(f.filename,'store',1,true);
  const exec=(command:CoreCommand,key?:string,principal?:StoragePrincipal)=>store.execute(envelope(command,key,principal));
  const ok=(command:CoreCommand,key?:string,principal?:StoragePrincipal):any=>{const result=exec(command,key,principal);assert.equal(result.state,'committed');return result.state==='committed'?result.value:null;};
  const prepare=(kind:'project'|'session'='project',id=project,principal:StoragePrincipal=owner)=>ok({name:'trash.prepareSoftDelete',input:{jobId:randomUUID(),kind,resourceId:id}},undefined,principal) as SoftDeleteJob;
  const claim=(jobId:string,threadId='new-thread',observedArchived=false,principal:StoragePrincipal=owner)=>{const token=randomUUID(),command={name:'trash.claimTrashArchive' as const,input:{jobId,threadId,observedArchived,claimToken:token}},key=randomUUID();return{token,key,command,result:exec(command,key,principal)};};
  const confirm=(jobId:string,principal:StoragePrincipal=owner)=>{
    const c=claim(jobId,'new-thread',false,principal);assert.equal(c.result.state,'committed');
    ok({name:'trash.confirmTrashArchive',input:{jobId,threadId:'new-thread',evidence:{kind:'provider-reply',wasAlreadyArchived:false}}},undefined,principal);
    assert.equal(claim(jobId,'already-thread',true,principal).result.state,'committed');
  };
  return{f,store,exec,ok,prepare,claim,confirm,cleanup:()=>{store.close();f.cleanup();}};
}

test('cancellation freezes original deletion and restores only provider-confirmed new archives',()=>{
  const p=prepared();try{const job=p.prepare();p.confirm(job.jobId);const cancel=p.ok({name:'trash.beginSoftDeleteCancel',input:{jobId:job.jobId}}) as SoftDeleteJob;assert.equal(cancel.phase,'cancelling');assert.deepEqual(cancel.compensations,[{threadId:'new-thread',phase:'prepared'}]);
    assert.equal(p.exec({name:'trash.commitSoftDelete',input:{jobId:job.jobId}}).state,'rejected');assert.equal(p.claim(job.jobId).result.state,'rejected');
    assert.equal(p.exec({name:'session.update',input:{sessionId:a,changes:{title:'blocked'}}}).state,'rejected');assert.equal(p.exec({name:'trash.finishSoftDeleteCancel',input:{jobId:job.jobId}}).state,'rejected');
    const token=randomUUID();p.ok({name:'trash.claimTrashRestore',input:{jobId:job.jobId,threadId:'new-thread',observedUnarchived:false,claimToken:token}});
    assert.equal(p.store.checkTrashRestoreDispatch({principal:owner,jobId:job.jobId,threadId:'new-thread',claimToken:token}),true);p.ok({name:'trash.confirmTrashRestore',input:{jobId:job.jobId,threadId:'new-thread',observedUnarchived:true,providerAcknowledged:true,claimToken:token}});
    const finished=p.ok({name:'trash.finishSoftDeleteCancel',input:{jobId:job.jobId}}) as SoftDeleteJob;assert.equal(finished.phase,'abandoned');assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),null);assert.equal(p.f.scalar(`SELECT deleted_at FROM sessions WHERE id='${old}'`),7);assert.equal(p.f.scalar(`SELECT codex_archived_for_trash FROM sessions WHERE id='${old}'`),1);assert.equal(p.f.scalar('SELECT count(*) FROM shared_records'),1);
    p.ok({name:'session.update',input:{sessionId:a,changes:{title:'released'}}});assert.equal(p.store.checkTrashRestoreDispatch({principal:owner,jobId:job.jobId,threadId:'new-thread',claimToken:token}),false);
  }finally{p.cleanup();}
});

test('unsettled archives and observation-only attribution remain blocked rather than guessing compensation',()=>{
  for(const observed of [false,true]){const p=prepared();try{const job=p.prepare();p.claim(job.jobId);if(observed)p.ok({name:'trash.confirmTrashArchive',input:{jobId:job.jobId,threadId:'new-thread',evidence:{kind:'fresh-observation',archived:true}}});
    const result=p.exec({name:'trash.beginSoftDeleteCancel',input:{jobId:job.jobId}});assert.equal(result.state,'rejected');assert.equal(p.store.readSoftDeleteJob({principal:owner,jobId:job.jobId})!.phase,'prepared');assert.equal(p.f.scalar('SELECT count(*) FROM _relay_trash_compensations'),0);
  }finally{p.cleanup();}}
});

test('unused cancellation and already-unarchived compensation require no provider write',()=>{
  for(const used of [false,true]){const p=prepared();try{const job=p.prepare();if(used)p.confirm(job.jobId);p.ok({name:'trash.beginSoftDeleteCancel',input:{jobId:job.jobId}});
    if(used){const result=p.ok({name:'trash.claimTrashRestore',input:{jobId:job.jobId,threadId:'new-thread',observedUnarchived:true,claimToken:randomUUID()}});assert.equal(result.claimed,false);assert.equal(result.alreadyConfirmed,true);}
    assert.equal(p.ok({name:'trash.finishSoftDeleteCancel',input:{jobId:job.jobId}}).phase,'abandoned');assert.equal(p.f.scalar(`SELECT deleted_at FROM sessions WHERE id='${a}'`),null);
  }finally{p.cleanup();}}
});

test('maintenance resumes explicit cancellation but cannot choose a new cancellation',()=>{
  const p=prepared();try{const job=p.prepare('project',project,admin);p.confirm(job.jobId,admin);assert.throws(()=>p.exec({name:'trash.beginSoftDeleteCancel',input:{jobId:job.jobId}},undefined,maintenance),{code:'FORBIDDEN'});p.ok({name:'trash.beginSoftDeleteCancel',input:{jobId:job.jobId}},undefined,admin);
    const token=randomUUID();p.ok({name:'trash.claimTrashRestore',input:{jobId:job.jobId,threadId:'new-thread',observedUnarchived:false,claimToken:token}},undefined,maintenance);assert.equal(p.store.checkTrashRestoreDispatch({principal:maintenance,jobId:job.jobId,threadId:'new-thread',claimToken:token}),true);
    p.ok({name:'trash.confirmTrashRestore',input:{jobId:job.jobId,threadId:'new-thread',observedUnarchived:true,providerAcknowledged:true,claimToken:token}},undefined,maintenance);assert.equal(p.ok({name:'trash.finishSoftDeleteCancel',input:{jobId:job.jobId}},undefined,admin).phase,'abandoned');assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='failed'"),1);
  }finally{p.cleanup();}
});

test('cancel receipts atomically roll back plans and do not release fences before a durable finish',()=>{
  const p=prepared();try{const job=p.prepare();p.confirm(job.jobId);p.f.mutate("CREATE TRIGGER cancel_fail BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='trash.beginSoftDeleteCancel' BEGIN SELECT RAISE(ABORT,'synthetic');END");assert.equal(p.exec({name:'trash.beginSoftDeleteCancel',input:{jobId:job.jobId}}).state,'unknown');assert.equal(p.f.scalar('SELECT count(*) FROM _relay_trash_compensations'),0);assert.equal(p.store.readSoftDeleteJob({principal:owner,jobId:job.jobId})!.phase,'prepared');p.f.mutate('DROP TRIGGER cancel_fail');
    p.ok({name:'trash.beginSoftDeleteCancel',input:{jobId:job.jobId}});p.ok({name:'trash.claimTrashRestore',input:{jobId:job.jobId,threadId:'new-thread',observedUnarchived:true,claimToken:randomUUID()}});
    p.f.mutate("CREATE TRIGGER finish_cancel_fail BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='trash.finishSoftDeleteCancel' BEGIN SELECT RAISE(ABORT,'synthetic');END");assert.equal(p.exec({name:'trash.finishSoftDeleteCancel',input:{jobId:job.jobId}}).state,'unknown');assert.equal(p.store.readSoftDeleteJob({principal:owner,jobId:job.jobId})!.phase,'cancelling');assert.equal(p.exec({name:'session.update',input:{sessionId:a,changes:{title:'blocked'}}}).state,'rejected');
  }finally{p.cleanup();}
});

test('restore claims never repeat after writer restart and old capabilities cannot dispatch',async()=>{
  const p=prepared();let port:StorageWorkerClient|undefined;try{const job=p.prepare();p.confirm(job.jobId);p.ok({name:'trash.beginSoftDeleteCancel',input:{jobId:job.jobId}});const token=randomUUID();p.ok({name:'trash.claimTrashRestore',input:{jobId:job.jobId,threadId:'new-thread',observedUnarchived:false,claimToken:token}});p.store.close();port=await StorageWorkerClient.open({filename:p.f.filename,storeId:'store',generation:2});assert.equal(await port.checkTrashRestoreDispatch({principal:owner,jobId:job.jobId,threadId:'new-thread',claimToken:token}),false);
    const again=await port.execute({...envelope({name:'trash.claimTrashRestore',input:{jobId:job.jobId,threadId:'new-thread',observedUnarchived:false,claimToken:randomUUID()}}),workerGeneration:2});assert.ok(again.state==='committed'&&!(again.value as any).claimed);assert.equal((await port.readSoftDeleteJob({principal:maintenance,jobId:job.jobId}))!.compensations[0]!.phase,'dispatched');
  }finally{if(port)await port.close();p.cleanup();}
});

test('source or current authority changes fence compensation and scope stays frozen',()=>{
  const p=prepared();try{const job=p.prepare('project',project,admin);p.confirm(job.jobId,admin);p.ok({name:'trash.beginSoftDeleteCancel',input:{jobId:job.jobId}},undefined,admin);const token=randomUUID();p.ok({name:'trash.claimTrashRestore',input:{jobId:job.jobId,threadId:'new-thread',observedUnarchived:false,claimToken:token}},undefined,admin);
    p.f.mutate(`UPDATE sessions SET updated_at=2 WHERE id='${a}'`);assert.equal(p.store.checkTrashRestoreDispatch({principal:admin,jobId:job.jobId,threadId:'new-thread',claimToken:token}),false);assert.equal(p.exec({name:'trash.confirmTrashRestore',input:{jobId:job.jobId,threadId:'new-thread',observedUnarchived:true,providerAcknowledged:true,claimToken:token}},undefined,admin).state,'rejected');p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");assert.throws(()=>p.store.checkTrashRestoreDispatch({principal:admin,jobId:job.jobId,threadId:'new-thread',claimToken:token}),{code:'FORBIDDEN'});
  }finally{p.cleanup();}
});
test('owner preparation groups duplicate Codex threads and excludes old trash from new archive effects',()=>{
  const p=prepared();try{const job=p.prepare();assert.equal(job.phase,'prepared');assert.equal(job.targets.length,5);assert.equal(job.targets.find(t=>t.sessionId===old)!.alreadyDeleted,true);
    assert.deepEqual(job.archives.map(e=>e.threadId),['already-thread','new-thread']);assert.ok(job.archives.every(e=>e.phase==='prepared'));
    const encoded=JSON.stringify(job);assert.ok(!encoded.includes('D:/'));assert.ok(!encoded.includes('auth-owner'));assert.ok(!encoded.includes('dispatch_token'));
    assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),null);assert.equal(p.f.scalar(`SELECT codex_archived FROM sessions WHERE id='${a}'`),0);
    assert.equal(p.store.readSoftDeleteJob({principal:admin,jobId:job.jobId})!.phase,'prepared');
    assert.throws(()=>p.store.readSoftDeleteJob({principal:{kind:'user',userId:'other',authSessionHash:'auth-other'},jobId:job.jobId}),{code:'FORBIDDEN'});
  }finally{p.cleanup();}
});
test('a dispatch right is claimed once and its exact private token guards the current source',()=>{
  const p=prepared();try{const job=p.prepare(),c=p.claim(job.jobId);assert.equal(c.result.state,'committed');assert.ok(c.result.state==='committed'&&(c.result.value as any).claimed);
    assert.equal(p.store.checkTrashArchiveDispatch({principal:owner,jobId:job.jobId,threadId:'new-thread',claimToken:c.token}),true);
    assert.equal(p.store.checkTrashArchiveDispatch({principal:owner,jobId:job.jobId,threadId:'new-thread',claimToken:randomUUID()}),false);
    const again=p.claim(job.jobId);assert.ok(again.result.state==='committed'&&!(again.result.value as any).claimed);
    assert.equal(p.exec({name:'trash.commitSoftDelete',input:{jobId:job.jobId}}).state,'rejected');
    assert.equal(p.exec({name:'trash.abandonSoftDelete',input:{jobId:job.jobId}},undefined,maintenance).state,'rejected');
    assert.equal(p.f.scalar(`SELECT deleted_at FROM sessions WHERE id='${a}'`),null);
    p.ok({name:'trash.confirmTrashArchive',input:{jobId:job.jobId,threadId:'new-thread',evidence:{kind:'provider-reply',wasAlreadyArchived:false}}});
    assert.equal(p.store.checkTrashArchiveDispatch({principal:owner,jobId:job.jobId,threadId:'new-thread',claimToken:c.token}),false);
  }finally{p.cleanup();}
});
test('confirmed project deletion atomically preserves history and terminal status with correct restore markers',()=>{
  const p=prepared();try{const job=p.prepare('project',project,admin);p.confirm(job.jobId,admin);const result=p.ok({name:'trash.commitSoftDelete',input:{jobId:job.jobId}},undefined,admin)as SoftDeleteJob;assert.equal(result.phase,'committed');
    for(const id of [a,a2,b,plain])assert.equal(typeof p.f.scalar(`SELECT deleted_at FROM sessions WHERE id='${id}'`),'number');
    assert.equal(p.f.scalar(`SELECT codex_archived_for_trash FROM sessions WHERE id='${a}'`),1);assert.equal(p.f.scalar(`SELECT codex_archived_for_trash FROM sessions WHERE id='${a2}'`),1);
    assert.equal(p.f.scalar(`SELECT codex_archived_for_trash FROM sessions WHERE id='${b}'`),0);assert.equal(p.f.scalar(`SELECT status FROM sessions WHERE id='${b}'`),'stopped');
    assert.equal(p.f.scalar(`SELECT deleted_at FROM sessions WHERE id='${old}'`),7);assert.equal(p.f.scalar(`SELECT updated_at FROM sessions WHERE id='${old}'`),1);
    assert.equal(p.f.scalar("SELECT content FROM messages WHERE id='soft-message'"),'preserved');assert.equal(p.f.scalar('SELECT count(*) FROM shared_records'),1);
    assert.equal(p.f.scalar('SELECT count(*) FROM sidebar_order_items'),0);assert.equal(p.f.scalar('SELECT count(*) FROM sidebar_order_scopes'),0);
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE action='project.delete' AND result IN ('started','succeeded')"),2);
    assert.equal(p.f.scalar(`SELECT deleted_at FROM sessions WHERE id='${sibling}'`),null);
  }finally{p.cleanup();}
});
test('archive confirmation uses positive reply or fresh positive observation; maintenance cannot submit a new deletion',()=>{
  const p=prepared();try{const job=p.prepare();p.claim(job.jobId);
    assert.equal(p.exec({name:'trash.confirmTrashArchive',input:{jobId:job.jobId,threadId:'new-thread',evidence:{kind:'provider-reply',wasAlreadyArchived:false}}},undefined,maintenance).state,'rejected');
    p.ok({name:'trash.confirmTrashArchive',input:{jobId:job.jobId,threadId:'new-thread',evidence:{kind:'fresh-observation',archived:true}}},undefined,maintenance);
    assert.equal(p.exec({name:'trash.confirmTrashArchive',input:{jobId:job.jobId,threadId:'new-thread',evidence:{kind:'provider-reply',wasAlreadyArchived:false}}},undefined,maintenance).state,'rejected');
    assert.equal(p.store.readSoftDeleteJob({principal:owner,jobId:job.jobId})!.archives.find(e=>e.threadId==='new-thread')!.restoreOnRecovery,true);
    const c=p.claim(job.jobId,'already-thread',true);assert.ok(c.result.state==='committed'&&(c.result.value as any).alreadyConfirmed);
    p.ok({name:'trash.commitSoftDelete',input:{jobId:job.jobId}});
    assert.throws(()=>parseCommandEnvelope(envelope({name:'trash.commitSoftDelete',input:{jobId:job.jobId}},randomUUID(),maintenance)),{code:'FORBIDDEN'});
    assert.throws(()=>parseCommandEnvelope(envelope({name:'trash.confirmTrashArchive',input:{jobId:job.jobId,threadId:'new-thread',evidence:{kind:'fresh-observation',archived:false} as any}})),{code:'INVALID_ARGUMENT'});
  }finally{p.cleanup();}
});
test('an already archived provider reply does not create a new restore-on-recovery obligation',()=>{
  const p=prepared();try{const job=p.prepare();p.claim(job.jobId);
    p.ok({name:'trash.confirmTrashArchive',input:{jobId:job.jobId,threadId:'new-thread',evidence:{kind:'provider-reply',wasAlreadyArchived:true}}});p.claim(job.jobId,'already-thread',true);
    p.ok({name:'trash.commitSoftDelete',input:{jobId:job.jobId}});assert.equal(p.f.scalar(`SELECT codex_archived_for_trash FROM sessions WHERE id='${a}'`),0);
  }finally{p.cleanup();}
});
test('claim receipt failure leaves the dispatch right unused; retry and a second claim remain distinct',()=>{
  const p=prepared();try{const job=p.prepare();p.f.mutate("CREATE TRIGGER reject_claim BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='trash.claimTrashArchive' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    const c=p.claim(job.jobId);assert.equal(c.result.state,'unknown');assert.equal(p.store.readSoftDeleteJob({principal:owner,jobId:job.jobId})!.archives.find(e=>e.threadId==='new-thread')!.phase,'prepared');
    assert.equal(p.store.checkTrashArchiveDispatch({principal:owner,jobId:job.jobId,threadId:'new-thread',claimToken:c.token}),false);
    p.f.mutate('DROP TRIGGER reject_claim');p.ok(c.command,c.key);assert.equal((p.claim(job.jobId).result as any).value.claimed,false);
  }finally{p.cleanup();}
});
test('local receipt failure rolls back trash flags, markers, sort cleanup, success audit and barrier while retaining confirmed evidence',()=>{
  const p=prepared();try{const job=p.prepare('project',project,admin);p.confirm(job.jobId,admin);p.f.mutate("CREATE TRIGGER reject_soft BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='trash.commitSoftDelete' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    const key=randomUUID(),command={name:'trash.commitSoftDelete' as const,input:{jobId:job.jobId}};assert.equal(p.exec(command,key,admin).state,'unknown');
    assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),null);assert.equal(p.f.scalar(`SELECT codex_archived FROM sessions WHERE id='${a}'`),0);assert.equal(p.f.scalar('SELECT count(*) FROM sidebar_order_items'),2);
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='started'"),1);assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='succeeded'"),0);assert.equal(p.store.readSoftDeleteJob({principal:admin,jobId:job.jobId})!.phase,'prepared');
    p.f.mutate('DROP TRIGGER reject_soft');p.ok(command,key,admin);p.ok(command,key,admin);assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='succeeded'"),1);
  }finally{p.cleanup();}
});
test('binding changes or default-project changes invalidate the dispatch guard without deleting the resource',()=>{
  const p=prepared();try{const job=p.prepare(),c=p.claim(job.jobId);
    p.f.mutate(`UPDATE sessions SET codex_thread_id='replacement',engine_session_id='replacement' WHERE id='${a}'`);
    assert.equal(p.store.checkTrashArchiveDispatch({principal:owner,jobId:job.jobId,threadId:'new-thread',claimToken:c.token}),false);
    assert.equal(p.exec({name:'trash.confirmTrashArchive',input:{jobId:job.jobId,threadId:'new-thread',evidence:{kind:'fresh-observation',archived:true}}}).state,'rejected');
    assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),null);
    p.f.mutate(`UPDATE sessions SET codex_thread_id='new-thread',engine_session_id='new-thread' WHERE id='${a}'`);
    assert.equal(p.store.checkTrashArchiveDispatch({principal:owner,jobId:job.jobId,threadId:'new-thread',claimToken:c.token}),true);
    p.f.mutate(`UPDATE users SET default_project_id='${project}' WHERE id='owner'`);
    assert.equal(p.store.checkTrashArchiveDispatch({principal:owner,jobId:job.jobId,threadId:'new-thread',claimToken:c.token}),false);
  }finally{p.cleanup();}
});
test('pending scopes block mutation, restore, purge and default assignment while unrelated sessions remain writable',()=>{
  const p=prepared();try{const job=p.prepare(),restore=p.store.readTrash({principal:owner,name:'restorePlan',input:{kind:'session',id:old}});
    const commands:CoreCommand[]=[{name:'project.update',input:{projectId:project,changes:{name:'changed'}}},{name:'session.update',input:{sessionId:a,changes:{title:'changed'}}},
      {name:'session.create',input:{sessionId:randomUUID(),projectId:project,title:'new',engine:'codex'}},{name:'share.revoke',input:{shareId:share}},
      {name:'account.setDefaultProject',input:{projectId:project}},{name:'trash.restoreSession',input:{sessionId:old,sourceDigest:restore.sourceDigest}},
      {name:'trash.preparePurge',input:{jobId:randomUUID(),kind:'session',resourceId:old,impactRevision:'0'.repeat(64),confirmationName:null}}];
    for(const command of commands)assert.equal(p.exec(command,undefined,command.name==='trash.preparePurge'?admin:owner).state,'rejected',command.name);
    p.ok({name:'session.update',input:{sessionId:sibling,changes:{title:'unrelated'}}});assert.equal(p.store.readSoftDeleteJob({principal:owner,jobId:job.jobId})!.phase,'prepared');
  }finally{p.cleanup();}
});
test('archive refresh skips frozen targets and the commit barrier rejects snapshots older than deletion',()=>{
  const p=prepared();try{const begun=p.ok({name:'archive.beginSnapshot',input:{}},undefined,maintenance),job=p.prepare();
    p.ok({name:'archive.applySnapshot',input:{version:begun.version,archivedThreadIds:['new-thread','sibling-thread']}},undefined,maintenance);
    assert.equal(p.f.scalar(`SELECT codex_archived FROM sessions WHERE id='${a}'`),0);assert.equal(p.f.scalar(`SELECT codex_archived FROM sessions WHERE id='${sibling}'`),1);
    p.confirm(job.jobId);p.ok({name:'trash.commitSoftDelete',input:{jobId:job.jobId}});
    const stale=p.exec({name:'archive.applySnapshot',input:{version:begun.version,archivedThreadIds:[]}},undefined,maintenance);assert.ok(stale.state==='rejected'&&stale.code==='SUPERSEDED');
  }finally{p.cleanup();}
});
test('safe abandonment is allowed only before any potentially new archive dispatch and releases the scope',()=>{
  const p=prepared();try{const job=p.prepare();p.claim(job.jobId,'already-thread',true);assert.equal((p.ok({name:'trash.abandonSoftDelete',input:{jobId:job.jobId}},undefined,maintenance)as SoftDeleteJob).phase,'abandoned');
    p.ok({name:'session.update',input:{sessionId:a,changes:{title:'after cancellation'}}});assert.equal(p.exec({name:'trash.commitSoftDelete',input:{jobId:job.jobId}}).state,'rejected');
    const next=p.prepare();p.claim(next.jobId);assert.equal(p.exec({name:'trash.abandonSoftDelete',input:{jobId:next.jobId}},undefined,maintenance).state,'rejected');
  }finally{p.cleanup();}
});
test('system, protected, default, foreign-owner and inconsistent/shared external bindings refuse preparation',()=>{
  const p=prepared();try{
    for(const change of [`UPDATE projects SET is_system=1 WHERE id='${project}'`,`UPDATE projects SET is_system=0,deletion_protected=1 WHERE id='${project}'`,`UPDATE projects SET deletion_protected=0 WHERE id='${project}';UPDATE users SET default_project_id='${project}' WHERE id='owner'`]){
      p.f.mutate(change);assert.equal(p.exec({name:'trash.prepareSoftDelete',input:{jobId:randomUUID(),kind:'project',resourceId:project}}).state,'rejected');}
    p.f.mutate("UPDATE users SET default_project_id=NULL");assert.equal(p.exec({name:'trash.prepareSoftDelete',input:{jobId:randomUUID(),kind:'project',resourceId:project}},undefined,{kind:'user',userId:'other',authSessionHash:'auth-other'}).state,'rejected');
    p.f.mutate(`UPDATE sessions SET engine_session_id='mismatch' WHERE id='${a}'`);assert.equal(p.exec({name:'trash.prepareSoftDelete',input:{jobId:randomUUID(),kind:'project',resourceId:project}}).state,'rejected');
    p.f.mutate(`UPDATE sessions SET engine_session_id='new-thread' WHERE id='${a}';UPDATE sessions SET codex_thread_id=NULL,engine_session_id='new-thread' WHERE id='${sibling}'`);
    assert.equal(p.exec({name:'trash.prepareSoftDelete',input:{jobId:randomUUID(),kind:'project',resourceId:project}}).state,'rejected');assert.equal(p.f.scalar('SELECT count(*) FROM _relay_soft_delete_jobs'),0);
  }finally{p.cleanup();}
});
test('running, leased, queued, uncertain followup and external-operation facts are checked before registration',()=>{
  const p=prepared();try{const attempt=()=>p.exec({name:'trash.prepareSoftDelete',input:{jobId:randomUUID(),kind:'project',resourceId:project}});
    p.f.mutate(`UPDATE sessions SET status='recovering' WHERE id='${a}'`);assert.equal(attempt().state,'rejected');p.f.mutate(`UPDATE sessions SET status='completed',active_attempt_id='active' WHERE id='${a}'`);assert.equal(attempt().state,'rejected');
    p.f.mutate(`UPDATE sessions SET active_attempt_id=NULL WHERE id='${a}';INSERT INTO engine_resource_leases VALUES('soft-attempt','${a}','soft-lease','running','codex','codex:soft',1,1)`);assert.equal(attempt().state,'rejected');p.f.mutate("DELETE FROM engine_resource_leases WHERE attempt_id='soft-attempt'");
    p.f.mutate(`INSERT INTO engine_queue_entries(id,session_id,attempt_id,user_message_id,engine_id,resource_key,requested_by_user_id,state,created_at) VALUES('soft-q','${a}','soft-attempt','soft-message','codex','codex:soft','owner','queued',1)`);assert.equal(attempt().state,'rejected');p.f.mutate("DELETE FROM engine_queue_entries WHERE id='soft-q'");
    p.f.mutate(`INSERT INTO session_followups(id,session_id,user_id,content,state,created_at,updated_at) VALUES('soft-f','${a}','owner','pending','uncertain',1,1)`);assert.equal(attempt().state,'rejected');p.f.mutate("DELETE FROM session_followups WHERE id='soft-f'");
    p.f.mutate(`INSERT INTO _relay_external_operations VALUES('soft-external','unarchive','owner','${a}','digest','new-thread','prepared',1,1)`);assert.equal(attempt().state,'rejected');assert.equal(p.f.scalar('SELECT count(*) FROM _relay_soft_delete_jobs'),0);
  }finally{p.cleanup();}
});
test('single non-Codex deletion leaves active siblings usable and replay cannot delete a restored session again',()=>{
  const p=prepared();try{const job=p.prepare('session',plain);assert.equal(job.archives.length,0);
    p.ok({name:'session.update',input:{sessionId:a,changes:{title:'sibling remains writable'}}});const key=randomUUID(),command={name:'trash.commitSoftDelete' as const,input:{jobId:job.jobId}};p.ok(command,key);
    assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),null);assert.equal(p.f.scalar(`SELECT status FROM sessions WHERE id='${plain}'`),'failed');
    const restore=p.store.readTrash({principal:owner,name:'restorePlan',input:{kind:'session',id:plain}});p.ok({name:'trash.restoreSession',input:{sessionId:plain,sourceDigest:restore.sourceDigest}});
    p.ok(command,key);assert.equal(p.f.scalar(`SELECT deleted_at FROM sessions WHERE id='${plain}'`),null);
  }finally{p.cleanup();}
});
test('old dispatch capabilities do not transfer to a reopened writer and a fresh claim cannot repeat the write',async()=>{
  const p=prepared();let port:StorageWorkerClient|undefined;try{const job=p.prepare(),claim=p.claim(job.jobId);assert.equal(claim.result.state,'committed');p.store.close();
    port=await StorageWorkerClient.open({filename:p.f.filename,storeId:'store',generation:2});
    assert.equal(await port.checkTrashArchiveDispatch({principal:owner,jobId:job.jobId,threadId:'new-thread',claimToken:claim.token}),false);
    const again=await port.execute({...envelope({name:'trash.claimTrashArchive',input:{jobId:job.jobId,threadId:'new-thread',observedArchived:false,claimToken:randomUUID()}}),workerGeneration:2});assert.ok(again.state==='committed'&&!(again.value as any).claimed);
    const state=await port.readSoftDeleteJob({principal:maintenance,jobId:job.jobId});assert.equal(state!.phase,'prepared');assert.equal(state!.archives.find(e=>e.threadId==='new-thread')!.phase,'dispatched');
    assert.ok(!JSON.stringify(state).includes(claim.token));
  }finally{if(port)await port.close();p.cleanup();}
});
test('large projects refuse explicitly and revoked or downgraded authority cannot recover private receipts',()=>{
  const p=prepared();try{const job=p.prepare('project',project,admin),key=randomUUID(),claimCommand={name:'trash.claimTrashArchive' as const,input:{jobId:job.jobId,threadId:'new-thread',observedArchived:false,claimToken:randomUUID()}};p.ok(claimCommand,key,admin);
    p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");assert.throws(()=>p.store.lookup({storeId:'store',operationId:key,principal:admin}),{code:'FORBIDDEN'});
    assert.throws(()=>p.store.readSoftDeleteJob({principal:admin,jobId:job.jobId}),{code:'FORBIDDEN'});
  }finally{p.cleanup();}
  const p2=prepared();try{p2.f.mutate(`WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1001)
    INSERT INTO sessions(id,owner_user_id,project_id,title,status,engine,message_revision) SELECT 'bulk-'||x,'owner','${project}','bulk','completed','codebuddy',0 FROM n`);
    const result=p2.exec({name:'trash.prepareSoftDelete',input:{jobId:randomUUID(),kind:'project',resourceId:project}});assert.ok(result.state==='rejected'&&result.code==='PAYLOAD_TOO_LARGE');
    assert.equal(p2.f.scalar('SELECT count(*) FROM _relay_soft_delete_jobs'),0);
  }finally{p2.cleanup();}
});
test('failed admin intent audit rolls back registration before any archive dispatch can be claimed',()=>{
  const p=prepared();try{p.f.mutate("CREATE TRIGGER reject_soft_audit BEFORE INSERT ON admin_audit_events WHEN NEW.action='project.delete' AND NEW.result='started' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    const result=p.exec({name:'trash.prepareSoftDelete',input:{jobId:randomUUID(),kind:'project',resourceId:project}},undefined,admin);assert.equal(result.state,'unknown');
    assert.equal(p.f.scalar('SELECT count(*) FROM _relay_soft_delete_jobs'),0);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_trash_archives'),0);
    assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),null);
  }finally{p.cleanup();}
});
test('admin operations on their own resources do not create impersonation audit entries',()=>{
  const p=prepared();try{p.f.mutate(`UPDATE projects SET owner_user_id='admin' WHERE id='${project}';UPDATE sessions SET owner_user_id='admin' WHERE project_id='${project}'`);
    const job=p.prepare('project',project,admin);p.confirm(job.jobId,admin);p.ok({name:'trash.commitSoftDelete',input:{jobId:job.jobId}},undefined,admin);
    assert.equal(p.f.scalar('SELECT count(*) FROM admin_audit_events'),0);
  }finally{p.cleanup();}
});
