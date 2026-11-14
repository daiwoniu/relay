import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './storage-fixture.test-support.js';
import { NativeStore } from './native-store.js';
import { StorageWorkerClient } from './worker-client.js';
import { parseCommandEnvelope } from './command-boundary.js';
import type { CoreCommand,StorageCommandEnvelope,PurgeJob } from './contracts.js';
const project='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222',child='33333333-3333-4333-8333-333333333333',child2='44444444-4444-4444-8444-444444444444';
const message='55555555-5555-4555-8555-555555555555',live='66666666-6666-4666-8666-666666666666',individual='77777777-7777-4777-8777-777777777777';
const share='88888888-8888-4888-8888-888888888888';
const admin={kind:'user' as const,userId:'admin',authSessionHash:'auth-admin'},maintenance={kind:'system' as const,purpose:'maintenance' as const},proof='b'.repeat(64);
function request(command:CoreCommand,operationId:string=randomUUID(),principal:StorageCommandEnvelope['principal']=admin):StorageCommandEnvelope{return{protocolVersion:1,storeId:'store',workerGeneration:1,requestId:randomUUID(),operationId,principal,command};}
function prepared(){
  const f=fixture();f.mutate(`INSERT INTO users(id,role,username) VALUES('${owner}','member','synthetic-owner');
    INSERT INTO projects(id,owner_user_id,path,name,deleted_at) VALUES('${project}','${owner}','D:/synthetic-purge','Trash project',1);
    INSERT INTO sessions(id,owner_user_id,project_id,status,message_revision,deleted_at) VALUES
      ('${child}','${owner}','${project}','completed',2,1),('${child2}','${owner}','${project}','failed',1,1),
      ('${live}','owner','project','completed',1,NULL),('${individual}','owner','project','completed',1,1);
    INSERT INTO messages(id,session_id,turn_id,role,content,created_at) VALUES('${message}','${child}','turn','user','synthetic',1),('child2-message','${child2}','turn','assistant','answer',2),('live-message','${live}','turn','assistant','live',1);
    INSERT INTO shared_records VALUES('${share}','${'a'.repeat(64)}','${owner}','${child}','Share','session',1,0,1,'{"version":1}',1,NULL,NULL);
    INSERT INTO workspace_console_links(id,workspace_path,task_id,session_id,relation_source,confidence,created_at,updated_at) VALUES('link','D:/synthetic','task','${child}','explicit','high',1,1);
    INSERT INTO context_compaction_events VALUES('${child}','thread','turn',1);
    INSERT INTO sidebar_order_items VALUES('main','project','${project}',0),('project:${project}','session','${child}',0);
    INSERT INTO sidebar_order_scopes VALUES('project:${project}',1);
    INSERT INTO session_read_receipts VALUES('${owner}','${child}','${message}',1);
    INSERT INTO session_followups(id,session_id,user_id,content,state,created_at,updated_at) VALUES('followup','${child}','${owner}','paused','paused',1,1);
    INSERT INTO approval_trust_settings VALUES('trust','${owner}',NULL,'${child}','manual',NULL,1,1);
    INSERT INTO project_members(project_id,user_id,role,can_view_sessions,created_at,updated_at) VALUES('${project}','other','viewer',1,1,1);
    INSERT INTO engine_turn_facts(id,session_id,attempt_id,engine,connection_id,fact_type,source,sequence,idempotency_key,observed_at,safe_payload_json,created_at)
      VALUES('purge-fact','${child}','purge-attempt','codex','connection','final_answer_completed','local',1,'purge-fact-key',1,'{}',1);
    INSERT INTO engine_terminal_decisions(id,session_id,attempt_id,engine,outcome,reason_code,fact_id,decided_at,projected_at)
      VALUES('purge-decision','${child}','purge-attempt','codex','completed','done','purge-fact',1,1);
    INSERT INTO engine_capacity_events VALUES('purge-capacity','codex:purge','purge-attempt','start_accepted',1);
    INSERT INTO engine_provider_cooldowns VALUES('codex:purge',2,999,'purge-attempt',1,1,1);`);
  const db=new DatabaseSync(f.filename);try{db.prepare('UPDATE messages SET metadata=? WHERE id=?').run(JSON.stringify({attachments:[{kind:'uploaded_file',id:randomUUID(),name:'payload.txt',path:'D:/synthetic-purge/.relay_upload/messages/'+message+'/payload.txt',size:7,mimeType:'text/plain',available:true}]}),message);}finally{db.close();}
  const store=new NativeStore(f.filename,'store',1,true);
  f.mutate(`INSERT INTO _relay_external_operations VALUES('effect','fork','admin','${child}','digest','thread','applied',1,1);
    INSERT INTO _relay_forks VALUES('effect','{}','fork-child','claim');
    INSERT INTO _relay_fork_messages VALUES('effect',0,'${message}','fork-message','digest');`);
  const exec=(command:CoreCommand,key?:string,principal?:StorageCommandEnvelope['principal'])=>store.execute(request(command,key,principal));
  const prepare=(kind:'project'|'session'='project',id=project,jobId=randomUUID())=>{
    const impact=store.readTrash({principal:admin,name:'impact',input:{kind,id}});
    const command={name:'trash.preparePurge' as const,input:{jobId,kind,resourceId:id,impactRevision:impact.impactRevision,confirmationName:kind==='project'?'Trash project':null}};
    const result=exec(command);assert.equal(result.state,'committed');return{jobId,command,result};
  };
  const ready=(jobId:string)=>{assert.equal(exec({name:'trash.startPurgeFiles',input:{jobId}}).state,'committed');
    const current=store.readPurgeJob({principal:admin,jobId})!;if(current.phase==='prepared')return current.intentDigest!;
    assert.equal(exec({name:'trash.bindPurgeProof',input:{jobId,intentDigest:proof}}).state,'committed');return proof;};
  return{f,store,exec,prepare,ready,cleanup:()=>{store.close();f.cleanup();}};
}
test('prepare registers only server-derived file scope and an immutable job before dispatch',()=>{
  const p=prepared();try{const {jobId}=p.prepare(),job=p.store.readPurgeJob({principal:admin,jobId})!;
    assert.equal(job.phase,'reserved');assert.equal(job.filesStarted,false);assert.equal(job.filesFinished,false);assert.equal(job.intentDigest,null);
    assert.deepEqual(job.request.entries,[{messageId:message,ownerUserId:owner}]);assert.equal(job.request.projectId,project);
    assert.equal(p.f.scalar(`SELECT count(*) FROM _relay_purge_sessions WHERE job_id='${jobId}'`),2);
    assert.equal(p.f.scalar(`SELECT count(*) FROM sessions WHERE project_id='${project}'`),2);
    assert.throws(()=>p.store.readPurgeJob({principal:{kind:'user',userId:'owner',authSessionHash:'auth-owner'},jobId}),{code:'FORBIDDEN'});
    assert.throws(()=>p.store.readPurgeJob({principal:{kind:'system',purpose:'scheduler'},jobId}),{code:'FORBIDDEN'});
  }finally{p.cleanup();}
});
test('phase/proof checks and current admin authority gate commit; purge is never an owner-only action',()=>{
  const p=prepared();try{
    const {jobId,command}=p.prepare();assert.equal(p.exec(command,randomUUID(),{kind:'user',userId:'owner',authSessionHash:'auth-owner'}).state,'rejected');
    assert.equal(p.exec({name:'trash.commitPurge',input:{jobId,intentDigest:proof}}).state,'rejected');p.ready(jobId);
    assert.equal(p.exec({name:'trash.commitPurge',input:{jobId,intentDigest:'c'.repeat(64)}}).state,'rejected');
    p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");assert.throws(()=>p.store.readPurgeJob({principal:admin,jobId}),{code:'FORBIDDEN'});
    assert.equal(p.exec({name:'trash.commitPurge',input:{jobId,intentDigest:proof}}).state,'rejected');
    assert.equal(p.exec({name:'trash.rejectPurge',input:{jobId}},randomUUID(),maintenance).state,'committed');
  }finally{p.cleanup();}
});
test('project commit deletes all scoped relations, preserves provider cooldown and retains proof until file completion',()=>{
  const p=prepared();try{const {jobId}=p.prepare();p.ready(jobId);
    const command={name:'trash.commitPurge' as const,input:{jobId,intentDigest:proof}},key=randomUUID(),first=p.exec(command,key);assert.equal(first.state,'committed');
    for(const table of ['projects','sessions','messages','shared_records','context_compaction_events','engine_turn_facts','engine_terminal_decisions','session_followups','workspace_console_links',
      'session_read_receipts','approval_trust_settings','project_members','sidebar_order_items','sidebar_order_scopes','_relay_external_operations','_relay_forks','_relay_fork_messages']){
      if(table==='projects')assert.equal(p.f.scalar(`SELECT count(*) FROM projects WHERE id='${project}'`),0);
      else if(table==='sessions')assert.equal(p.f.scalar(`SELECT count(*) FROM sessions WHERE project_id='${project}'`),0);
      else if(table==='messages')assert.equal(p.f.scalar(`SELECT count(*) FROM messages WHERE id='${message}'`),0);
      else assert.equal(p.f.scalar(`SELECT count(*) FROM ${table}`),0,table);
    }
    assert.equal(p.f.scalar("SELECT count(*) FROM engine_capacity_events WHERE id='purge-capacity'"),0);
    assert.equal(p.f.scalar("SELECT probe_attempt_id FROM engine_provider_cooldowns WHERE resource_key='codex:purge'"),null);
    assert.equal(p.f.scalar("SELECT consecutive_overloads FROM engine_provider_cooldowns WHERE resource_key='codex:purge'"),2);
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='succeeded' AND action='project.permanent_delete'"),1);
    assert.equal(p.store.readPurgeJob({principal:maintenance,jobId})!.phase,'committed');assert.equal(p.store.readPurgeJob({principal:admin,jobId})!.filesFinished,false);
    const replay=p.exec(command,key);assert.equal(replay.state,'committed');assert.ok(replay.state==='committed'&&replay.replayed);
    assert.equal(p.exec({name:'trash.rejectPurge',input:{jobId}},randomUUID(),maintenance).state,'rejected');
    assert.equal(p.exec({name:'trash.finishPurgeFiles',input:{jobId,intentDigest:proof}},randomUUID(),maintenance).state,'committed');
    assert.equal(p.store.readPurgeJob({principal:maintenance,jobId})!.filesFinished,true);assert.equal(p.f.scalar(`SELECT content FROM messages WHERE id='live-message'`),'live');
  }finally{p.cleanup();}
});
test('receipt failure atomically rolls back relations, audit and committed job phase',()=>{
  const p=prepared();try{const {jobId}=p.prepare();p.ready(jobId);p.f.mutate("CREATE TRIGGER reject_purge BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='trash.commitPurge' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    const command={name:'trash.commitPurge' as const,input:{jobId,intentDigest:proof}},key=randomUUID();assert.equal(p.exec(command,key).state,'unknown');
    assert.equal(p.f.scalar(`SELECT count(*) FROM sessions WHERE project_id='${project}'`),2);assert.equal(p.store.readPurgeJob({principal:admin,jobId})!.phase,'prepared');
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result IN ('started','succeeded')"),0);
    assert.equal(p.store.lookup({storeId:'store',operationId:key,principal:admin}).state,'not-found');
    p.f.mutate('DROP TRIGGER reject_purge');assert.equal(p.exec(command,key).state,'committed');
  }finally{p.cleanup();}
});
test('same operation recovers registration; different intent, duplicate jobs and stale revisions fail closed',()=>{
  const p=prepared();try{
    const impact=p.store.readTrash({principal:admin,name:'impact',input:{kind:'project',id:project}}),jobId=randomUUID();
    const command={name:'trash.preparePurge' as const,input:{jobId,kind:'project' as const,resourceId:project,impactRevision:impact.impactRevision,confirmationName:'Trash project'}};
    const key=randomUUID();assert.equal(p.exec(command,key).state,'committed');assert.equal(p.exec(command,key).state,'committed');
    assert.equal(p.exec({...command,input:{...command.input,jobId:randomUUID()}}).state,'rejected');
    assert.equal(p.exec({...command,input:{...command.input,confirmationName:'wrong'}},key).state,'rejected');
    p.f.mutate(`UPDATE messages SET content='changed after confirmation' WHERE id='${message}'`);
    assert.equal(p.exec({name:'trash.startPurgeFiles',input:{jobId}}).state,'rejected');assert.equal(p.store.readPurgeJob({principal:admin,jobId})!.phase,'reserved');
  }finally{p.cleanup();}
});
test('fences prevent restore, project edits, new children and share changes while unrelated work remains writable',()=>{
  const p=prepared();try{p.prepare();
    for(const command of [
      {name:'project.update',input:{projectId:project,changes:{name:'changed'}}},
      {name:'session.create',input:{sessionId:randomUUID(),projectId:project,title:'new',engine:'codex'}},
      {name:'session.update',input:{sessionId:live,changes:{projectId:project}}},
      {name:'share.revoke',input:{shareId:share}},
    ] as CoreCommand[]){const result=p.exec(command);assert.equal(result.state,'rejected');}
    const plan=p.store.readTrash({principal:admin,name:'restorePlan',input:{kind:'project',id:project}});
    assert.equal(p.exec({name:'trash.restoreProject',input:{projectId:project,sourceDigest:plan.sourceDigest}}).state,'rejected');
    assert.equal(p.exec({name:'session.update',input:{sessionId:live,changes:{title:'unrelated allowed'}}}).state,'committed');
    assert.equal(p.exec({name:'account.setDisplayName',input:{displayName:'still available'}}).state,'committed');
  }finally{p.cleanup();}
});
test('single-session purge leaves its parent and sibling usable, including running sibling facts',()=>{
  const p=prepared();try{const {jobId}=p.prepare('session',individual);const actualProof=p.ready(jobId);
    assert.equal(p.exec({name:'session.update',input:{sessionId:live,changes:{title:'sibling'}}}).state,'committed');
    p.f.mutate(`UPDATE sessions SET status='processing',engine='codex',active_attempt_id='sibling-attempt' WHERE id='${live}';
      INSERT INTO engine_resource_leases VALUES('sibling-attempt','${live}','sibling-lease','running','codex','codex:sibling',1,1)`);
    const runtime={kind:'runtime' as const,sessionId:live,attemptId:'sibling-attempt',connectionId:'sibling-connection',runtimeVersion:1};
    p.store.registerRuntime({storeId:'store',workerGeneration:1,leaseToken:'sibling-lease',runtime});
    const fact={id:randomUUID(),sessionId:live,attemptId:runtime.attemptId,engineId:'codex' as const,connectionId:runtime.connectionId,factType:'turn_started' as const,
      source:'realtime' as const,sequence:1,idempotencyKey:randomUUID(),observedAt:1,payload:{}};
    assert.equal(p.exec({name:'turn.appendFact',input:{fact}},randomUUID(),runtime).state,'committed');
    assert.equal(p.exec({name:'project.update',input:{projectId:'project',changes:{name:'changes impact'}}}).state,'rejected');
    assert.equal(p.exec({name:'trash.commitPurge',input:{jobId,intentDigest:actualProof}}).state,'committed');
    assert.equal(p.f.scalar(`SELECT count(*) FROM sessions WHERE id='${individual}'`),0);assert.equal(p.f.scalar(`SELECT count(*) FROM sessions WHERE id='${live}'`),1);assert.equal(p.f.scalar("SELECT count(*) FROM projects WHERE id='project'"),1);
  }finally{p.cleanup();}
});
test('rejection keeps scope fenced until explicit file completion; no-proof completion only before dispatch',()=>{
  const p=prepared();try{const {jobId}=p.prepare();assert.equal(p.exec({name:'trash.rejectPurge',input:{jobId}},randomUUID(),maintenance).state,'committed');
    assert.equal(p.exec({name:'project.update',input:{projectId:project,changes:{name:'blocked'}}}).state,'rejected');
    assert.equal(p.exec({name:'trash.finishPurgeFiles',input:{jobId,intentDigest:null}},randomUUID(),maintenance).state,'committed');
    const next=p.prepare();assert.notEqual(next.jobId,jobId);assert.equal(p.exec({name:'trash.startPurgeFiles',input:{jobId:next.jobId}}).state,'committed');
    assert.equal(p.exec({name:'trash.rejectPurge',input:{jobId:next.jobId}},randomUUID(),maintenance).state,'committed');
    assert.equal(p.exec({name:'trash.finishPurgeFiles',input:{jobId:next.jobId,intentDigest:null}},randomUUID(),maintenance).state,'rejected');
    assert.equal(p.exec({name:'trash.bindPurgeProof',input:{jobId:next.jobId,intentDigest:proof}},randomUUID(),maintenance).state,'committed');
    assert.equal(p.exec({name:'trash.finishPurgeFiles',input:{jobId:next.jobId,intentDigest:proof}},randomUUID(),maintenance).state,'committed');
  }finally{p.cleanup();}
});
test('commit rechecks source changes and keeps a known rejected result distinct from a durable rejection job',()=>{
  const p=prepared();try{const {jobId}=p.prepare();p.ready(jobId);
    p.f.mutate(`UPDATE _relay_forks SET child_id='changed-child' WHERE id='effect'`);
    assert.equal(p.exec({name:'trash.commitPurge',input:{jobId,intentDigest:proof}}).state,'rejected');
    assert.equal(p.store.readPurgeJob({principal:admin,jobId})!.phase,'prepared');assert.equal(p.f.scalar(`SELECT count(*) FROM sessions WHERE id='${child}'`),1);
    assert.equal(p.exec({name:'trash.rejectPurge',input:{jobId}},randomUUID(),maintenance).state,'committed');
    assert.equal(p.store.readPurgeJob({principal:maintenance,jobId})!.phase,'rejected');
  }finally{p.cleanup();}
});
test('strict purge commands reject browser file lists, runtime callers and scheduler maintenance impersonation',()=>{
  assert.throws(()=>parseCommandEnvelope(request({name:'trash.startPurgeFiles',input:{jobId:randomUUID(),path:'D:/injected'} as any})),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>parseCommandEnvelope(request({name:'trash.rejectPurge',input:{jobId:randomUUID()}},randomUUID(),{kind:'system',purpose:'scheduler'})),{code:'FORBIDDEN'});
  assert.throws(()=>parseCommandEnvelope(request({name:'trash.commitPurge',input:{jobId:randomUUID(),intentDigest:proof}},randomUUID(),maintenance)),{code:'FORBIDDEN'});
});
test('Worker reopen retains committed decision and exact proof after the deleted resource is gone',async()=>{
  const p=prepared();let port:StorageWorkerClient|undefined;try{const {jobId}=p.prepare();p.ready(jobId);const key=randomUUID(),command={name:'trash.commitPurge' as const,input:{jobId,intentDigest:proof}};
    assert.equal(p.exec(command,key).state,'committed');p.store.close();port=await StorageWorkerClient.open({filename:p.f.filename,storeId:'store',generation:2});
    const job=await port.readPurgeJob({principal:maintenance,jobId});assert.equal(job!.phase,'committed');assert.equal(job!.intentDigest,proof);
    const receipt=await port.lookup({storeId:'store',operationId:key,principal:admin});assert.equal(receipt.state,'committed');
    const replay=await port.execute({...request(command,key),workerGeneration:2});assert.equal(replay.state,'committed');
    p.f.mutate(`UPDATE _relay_storage_operations SET expired=1,result_json=NULL WHERE operation_id='${key}'`);
    assert.equal((await port.lookup({storeId:'store',operationId:key,principal:admin})).state,'expired');
    assert.equal((await port.readPurgeJob({principal:maintenance,jobId}))!.phase,'committed');
    await assert.rejects(port.readPurgeJob({principal:{kind:'user',userId:'other',authSessionHash:'auth-other'},jobId}),{code:'FORBIDDEN'});
  }finally{if(port)await port.close();p.cleanup();}
});
test('proof registration and its receipt are atomic; expired transport receipts do not erase task authority',()=>{
  const p=prepared();try{const {jobId}=p.prepare();assert.equal(p.exec({name:'trash.startPurgeFiles',input:{jobId}}).state,'committed');
    p.f.mutate("CREATE TRIGGER reject_proof BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='trash.bindPurgeProof' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    const command={name:'trash.bindPurgeProof' as const,input:{jobId,intentDigest:proof}},key=randomUUID();assert.equal(p.exec(command,key).state,'unknown');
    const job=p.store.readPurgeJob({principal:maintenance,jobId})!;assert.equal(job.phase,'isolating');assert.equal(job.intentDigest,null);
    p.f.mutate('DROP TRIGGER reject_proof');assert.equal(p.exec(command,key).state,'committed');
  }finally{p.cleanup();}
});
test('an attempt also referenced by another session cannot lose shared capacity history during purge',()=>{
  const p=prepared();try{const {jobId}=p.prepare();p.ready(jobId);
    p.f.mutate(`INSERT INTO engine_turn_facts(id,session_id,attempt_id,engine,connection_id,fact_type,source,sequence,idempotency_key,observed_at,safe_payload_json,created_at)
      VALUES('other-attempt-reference','${live}','purge-attempt','codex','connection','turn_started','local',1,'other-attempt-key',1,'{}',1)`);
    assert.equal(p.exec({name:'trash.commitPurge',input:{jobId,intentDigest:proof}}).state,'rejected');
    assert.equal(p.f.scalar("SELECT count(*) FROM engine_capacity_events WHERE id='purge-capacity'"),1);
    assert.equal(p.f.scalar("SELECT probe_attempt_id FROM engine_provider_cooldowns WHERE resource_key='codex:purge'"),'purge-attempt');
    assert.equal(p.f.scalar(`SELECT count(*) FROM sessions WHERE id='${child}'`),1);
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE action='project.permanent_delete' AND result='failed'"),1);
  }finally{p.cleanup();}
});
