import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StoredTrash } from './stored-trash.js';
import { StoredUnarchiveService } from './stored-unarchive.js';
import { createStoredTrashRouter } from '../routes/stored-trash.js';
import { hashSessionToken } from '../auth/session.js';
import { serializeSessionCookie } from '../auth/cookie.js';
const project='11111111-1111-4111-8111-111111111111',activeProject='22222222-2222-4222-8222-222222222222';
const child='33333333-3333-4333-8333-333333333333',child2='44444444-4444-4444-8444-444444444444',individual='55555555-5555-4555-8555-555555555555',other='66666666-6666-4666-8666-666666666666';
const principal=(id='owner')=>({kind:'user' as const,userId:id,authSessionHash:hashSessionToken(`synthetic-trash-${id}`)});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>((r)=>{resolve=r;});return{promise,resolve};}
async function prepared(){
  const f=fixture();
  f.mutate(`INSERT INTO projects(id,owner_user_id,path,name,deleted_at,pinned,pinned_at) VALUES('${project}','owner','D:/trash-project','Trash project',10,1,1),('${activeProject}','owner','D:/active-project','Active project',NULL,0,NULL);
    INSERT INTO sessions(id,owner_user_id,project_id,title,deleted_at,status,engine,engine_bound,codex_thread_id,codex_archived,codex_archived_for_trash,message_revision) VALUES
    ('${child}','owner','${project}','First child',10,'completed','codex',1,'trash-thread',1,1,2),('${child2}','owner','${project}','Second child',5,'failed','codebuddy',1,NULL,0,0,1),
    ('${individual}','owner','${activeProject}','Individual',7,'stopped','codex',1,NULL,0,0,12),('${other}','other','${activeProject}','Other private',8,'completed','codex',1,NULL,0,0,1);
    INSERT INTO messages(id,session_id,turn_id,role,content,phase,created_at,stopped) VALUES('${randomUUID()}','${child}','turn','assistant','literal %_ marker','final_answer',1,0);
    INSERT INTO sidebar_order_items VALUES('main','project','${project}',0),('project:${project}','session','${child}',0),('main','session','${individual}',1);
    INSERT INTO shared_records VALUES('${randomUUID()}','${'a'.repeat(64)}','owner','${child}','Retained share','session',1,0,1,'{"version":1,"sourceEngine":"codex","messages":[]}',1,NULL,NULL)`);
  for(let i=0;i<6;i++)f.mutate(`INSERT INTO messages(id,session_id,turn_id,role,content,phase,created_at,stopped) VALUES('${randomUUID()}','${individual}','turn-${i}','user','question ${i}',NULL,${i*2+1},0),('${randomUUID()}','${individual}','turn-${i}','assistant','answer ${i} marker','final_answer',${i*2+2},0)`);
  for(const id of ['owner','other','admin'])f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${principal(id).authSessionHash}','${id}',${Date.now()+600000})`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true}),archived=new Set(['trash-thread']),writes:string[]=[],notifications:string[]=[],checked:string[]=[];
  const unarchive=new StoredUnarchiveService({port,storeId:'store',generation:1,isThreadArchived:async(id)=>archived.has(id),
    unarchiveThread:async(id,guard)=>{if(!await guard())throw new Error('changed authority');writes.push(id);archived.delete(id);},closeIdleConnection:()=>{},changed:()=>{}});
  const defaults={port,storeId:'store',generation:1,verifyDirectory:async(value:string)=>{checked.push(value);},unarchive,
    projectChanged:async(id:string)=>{notifications.push(id);},sessionChanged:async(id:string)=>{notifications.push(id);},sidebarChanged:()=>{notifications.push('sidebar');}};
  const make=(overrides:Partial<ConstructorParameters<typeof StoredTrash>[0]>={})=>new StoredTrash({...defaults,...overrides}),service=make();
  const app=new Hono().route('/api/trash',createStoredTrashRouter({port,service}));
  const send=(route:string,method='GET',user='owner',key=randomUUID(),origin='http://localhost:9081')=>app.request(`http://localhost:9081/api/trash${route}`,{method,headers:{cookie:serializeSessionCookie(`synthetic-trash-${user}`,Date.now()+600000,false),origin,'x-relay-operation-id':key}});
  return {f,port,archived,writes,notifications,checked,unarchive,make,service,app,send,cleanup:async()=>{await port.close();f.cleanup();}};
}
test('trash queries preserve owner/admin isolation, literal matching, parent grouping and bounded preview turns',async()=>{
  const p=await prepared();try{
    const projects=await p.port.readTrash({principal:principal(),name:'projects',input:{limit:50,offset:0,q:'%_'}});assert.equal(projects.total,1);assert.equal(projects.items[0]!.matchSessionId,child);assert.equal(projects.items[0]!.matchCount,1);
    assert.equal((await p.port.readTrash({principal:principal('other'),name:'projects',input:{limit:50,offset:0,q:''}})).total,0);
    const mine=await p.port.readTrash({principal:principal(),name:'sessions',input:{limit:50,offset:0,q:'marker',projectId:null}});assert.equal(mine.total,1);assert.equal(mine.items[0]!.id,individual);assert.equal(mine.items[0]!.matchCount,6);
    assert.equal((await p.port.readTrash({principal:principal('admin'),name:'sessions',input:{limit:50,offset:0,q:'',projectId:null}})).total,2);
    assert.equal((await p.port.readTrash({principal:principal(),name:'projectSessions',input:{projectId:project,limit:50,offset:0}})).total,2);
    await assert.rejects(p.port.readTrash({principal:principal('other'),name:'projectSessions',input:{projectId:project,limit:50,offset:0}}),{code:'FORBIDDEN'});
    const preview=await p.port.readTrash({principal:principal(),name:'preview',input:{sessionId:individual}});assert.equal(preview.length,10);assert.equal(preview[0]!.content,'question 1');
    const matches=await p.port.readTrash({principal:principal(),name:'matches',input:{sessionId:individual,q:'marker',offset:1}});assert.equal(matches.total,6);assert.equal(matches.items[0]!.content,'answer 4 marker');
    assert.equal((await p.port.readTrash({principal:principal(),name:'options',input:{}}))[0]!.id,activeProject);
  }finally{await p.cleanup();}
});
test('project restore atomically recovers all children and sorting, then confirms only the trash-marked thread',async()=>{
  const p=await prepared();try{
    const key=randomUUID(),result=await p.service.restore(principal(),'project',project,key);assert.equal(result.state,'committed');if(result.state==='committed'){assert.equal(result.value.restoredSessionCount,2);assert.equal(result.value.unarchivedSessionCount,1);}
    assert.deepEqual(p.checked,['D:/trash-project']);assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),null);
    assert.equal(p.f.scalar(`SELECT count(*) FROM sessions WHERE project_id='${project}' AND deleted_at IS NULL`),2);assert.equal(p.f.scalar(`SELECT status FROM sessions WHERE id='${child2}'`),'failed');
    assert.equal(p.f.scalar(`SELECT codex_archived_for_trash FROM sessions WHERE id='${child}'`),0);assert.equal(p.f.scalar(`SELECT status FROM sessions WHERE id='${child}'`),'completed');
    assert.equal(p.f.scalar(`SELECT count(*) FROM sidebar_order_items WHERE item_id IN ('${project}','${child}')`),0);assert.equal(p.f.scalar('SELECT count(*) FROM shared_records'),1);assert.deepEqual(p.writes,['trash-thread']);
    assert.equal((await p.make().restore(principal(),'project',project,key)).state,'committed');assert.deepEqual(p.writes,['trash-thread']);
  }finally{await p.cleanup();}
});
test('single-session restoration leaves terminal state intact and requires an active parent',async()=>{
  const p=await prepared();try{
    await assert.rejects(p.service.restore(principal(),'session',child,randomUUID()),{code:'CONFLICT'});
    const result=await p.service.restore(principal(),'session',individual,randomUUID());assert.equal(result.state,'committed');assert.equal(p.f.scalar(`SELECT status FROM sessions WHERE id='${individual}'`),'stopped');assert.deepEqual(p.checked,[]);
    await assert.rejects(p.service.restore(principal(),'session',other,randomUUID()),{code:'FORBIDDEN'});
  }finally{await p.cleanup();}
});
test('receipt failure rolls back project, children, sort cleanup and audit before any external call',async()=>{
  const p=await prepared();try{
    p.f.mutate("CREATE TRIGGER reject_restore BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='trash.restoreProject' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    const key=randomUUID(),result=await p.service.restore(principal('admin'),'project',project,key);assert.deepEqual(result,{state:'unknown',localCommitted:false});
    assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),10);assert.equal(p.f.scalar(`SELECT deleted_at FROM sessions WHERE id='${child}'`),10);assert.equal(p.f.scalar('SELECT count(*) FROM sidebar_order_items'),3);
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE action='project.restore' AND result='succeeded'"),0);assert.deepEqual(p.writes,[]);
    p.f.mutate('DROP TRIGGER reject_restore');assert.equal((await p.service.restore(principal('admin'),'project',project,key)).state,'committed');
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE action='project.restore' AND result='succeeded'"),1);
  }finally{await p.cleanup();}
});
test('directory checks cannot authorize a changed path or a caller who lost admin authority',async()=>{
  const p=await prepared();try{
    const entered=deferred(),release=deferred(),service=p.make({verifyDirectory:async()=>{entered.resolve();await release.promise;}});
    const work=service.restore(principal('admin'),'project',project,randomUUID());await entered.promise;p.f.mutate(`UPDATE projects SET path='D:/changed-path' WHERE id='${project}'`);release.resolve();
    await assert.rejects(work,{code:'CONFLICT'});assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),10);
    const again=p.make({verifyDirectory:async()=>{p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");}});await assert.rejects(again.restore(principal('admin'),'project',project,randomUUID()),{code:'FORBIDDEN'});assert.deepEqual(p.writes,[]);
  }finally{await p.cleanup();}
});
test('active attempts, leases, queues and external pending effects prevent restoration',async()=>{
  const p=await prepared();try{
    p.f.mutate(`UPDATE sessions SET active_attempt_id='new-active' WHERE id='${child}'`);await assert.rejects(p.service.restore(principal(),'project',project,randomUUID()),{code:'CONFLICT'});
    p.f.mutate(`UPDATE sessions SET active_attempt_id=NULL WHERE id='${child}';INSERT INTO engine_resource_leases VALUES('trash-lease','${child}','lease','running','codex','codex:default',1,1)`);
    await assert.rejects(p.service.restore(principal(),'project',project,randomUUID()),{code:'CONFLICT'});
    p.f.mutate(`DELETE FROM engine_resource_leases WHERE attempt_id='trash-lease';INSERT INTO _relay_external_operations VALUES('pending','fork','owner','${child}','digest','thread','prepared',1,1)`);
    await assert.rejects(p.service.restore(principal(),'project',project,randomUUID()),{code:'CONFLICT'});assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),10);
    p.f.mutate(`DELETE FROM _relay_external_operations WHERE id='pending';INSERT INTO engine_queue_entries(id,session_id,attempt_id,user_message_id,engine_id,resource_key,requested_by_user_id,state,created_at)
      SELECT 'trash-queue','${child}','trash-attempt',id,'codex','codex:default','owner','queued',1 FROM messages WHERE session_id='${child}' LIMIT 1`);
    await assert.rejects(p.service.restore(principal(),'project',project,randomUUID()),{code:'CONFLICT'});
  }finally{await p.cleanup();}
});
test('ambiguous external work remains locally restored and is not reported as a definite failure or dispatched twice',async()=>{
  const p=await prepared();try{
    let calls=0;const ambiguous=new StoredUnarchiveService({port:p.port,storeId:'store',generation:1,isThreadArchived:async()=>null,unarchiveThread:async()=>{calls++;throw new Error('synthetic lost external reply');},closeIdleConnection:()=>{},changed:()=>{}});
    const key=randomUUID(),make=()=>p.make({unarchive:ambiguous});assert.deepEqual(await make().restore(principal(),'project',project,key),{state:'unknown',localCommitted:true});
    assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),null);assert.equal(calls,1);
    assert.deepEqual(await make().restore(principal(),'project',project,key),{state:'unknown',localCommitted:true});assert.equal(calls,1);
  }finally{await p.cleanup();}
});
test('restore-specific expected thread prevents unarchiving a replacement binding after local commit',async()=>{
  const p=await prepared();try{
    const bound={run:async(...args:Parameters<StoredUnarchiveService['run']>)=>{p.f.mutate(`UPDATE sessions SET codex_thread_id='replacement-thread',engine_session_id='replacement-thread' WHERE id='${child}'`);return p.unarchive.run(...args);}};
    assert.deepEqual(await p.make({unarchive:bound}).restore(principal(),'project',project,randomUUID()),{state:'unknown',localCommitted:true});assert.deepEqual(p.writes,[]);
  }finally{await p.cleanup();}
});
test('two sessions bound to one original thread cause only one external write',async()=>{
  const p=await prepared();try{
    p.f.mutate(`UPDATE sessions SET engine='codex',codex_thread_id='trash-thread',codex_archived=1,codex_archived_for_trash=1 WHERE id='${child2}'`);
    const result=await p.service.restore(principal(),'project',project,randomUUID());assert.equal(result.state,'committed');if(result.state==='committed')assert.equal(result.value.unarchivedSessionCount,2);assert.deepEqual(p.writes,['trash-thread']);
  }finally{await p.cleanup();}
});
test('postcommit notification/projection failures never roll back a restored resource',async()=>{
  const p=await prepared();try{
    const noisy=p.make({sessionChanged:()=>{throw new Error('synthetic notify failure');},sidebarChanged:()=>{throw new Error('synthetic sidebar failure');}});
    assert.equal((await noisy.restore(principal(),'session',individual,randomUUID())).state,'committed');assert.equal(p.f.scalar(`SELECT deleted_at FROM sessions WHERE id='${individual}'`),null);
  }finally{await p.cleanup();}
});
test('candidate trash HTTP preserves query validation, trusted origin, idempotency and local/remote distinction',async()=>{
  const p=await prepared();try{
    assert.equal((await p.send('/projects?limit=-1')).status,400);assert.equal((await p.send(`/projects/${project}/restore`,'POST','owner',randomUUID(),'https://untrusted.invalid')).status,403);
    assert.equal((await p.send(`/sessions/${individual}/restore`,'POST','other')).status,404);
    const key=randomUUID(),result=await p.send(`/projects/${project}/restore`,'POST','owner',key);assert.equal(result.status,200);assert.equal(result.headers.get('x-relay-operation-id'),key);assert.equal((await result.json()).restoredSessionCount,2);
    assert.equal((await p.send(`/projects/${project}/restore`,'POST','owner',key)).status,200);
    const bad=p.make({verifyDirectory:async()=>{throw new Error('private path failure');}});const app=new Hono().route('/api/trash',createStoredTrashRouter({port:p.port,service:bad}));
    p.f.mutate(`UPDATE projects SET deleted_at=20 WHERE id='${project}'`);
    const unavailable=await app.request(`http://localhost:9081/api/trash/projects/${project}/restore`,{method:'POST',headers:{cookie:serializeSessionCookie('synthetic-trash-owner',Date.now()+600000,false),origin:'http://localhost:9081'}});
    assert.equal(unavailable.status,409);assert.equal((await unavailable.json()).code,'TRASH_PROJECT_PATH_UNAVAILABLE');
  }finally{await p.cleanup();}
});

test('postcommit projection loss is reported as locally saved and can resume using the same receipt',async()=>{
  const p=await prepared();try{
    const read=p.port.readProject.bind(p.port);p.port.readProject=async()=>{throw new Error('synthetic projection unavailable');};
    const key=randomUUID();assert.deepEqual(await p.service.restore(principal(),'project',project,key),{state:'unknown',localCommitted:true});
    assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),null);assert.deepEqual(p.writes,[]);
    p.port.readProject=read;assert.equal((await p.service.restore(principal(),'project',project,key)).state,'committed');assert.deepEqual(p.writes,['trash-thread']);
  }finally{await p.cleanup();}
});

test('restore deadline retains the accepted job, so retries join it instead of rechecking and mutating twice',async()=>{
  const p=await prepared(),entered=deferred(),release=deferred();let checks=0;
  const service=p.make({timeoutMs:10,verifyDirectory:async()=>{checks++;entered.resolve();await release.promise;}});
  try{
    const key=randomUUID(),first=service.restore(principal(),'project',project,key);await entered.promise;
    assert.deepEqual(await first,{state:'unknown',localCommitted:false});assert.equal((service as any).jobs.size,1);
    assert.deepEqual(await service.restore(principal(),'project',project,key),{state:'unknown',localCommitted:false});assert.equal(checks,1);
    const jobs=[...(service as any).jobs.values()] as Array<{result:Promise<unknown>}>;release.resolve();await Promise.all(jobs.map(j=>j.result));
    assert.equal((service as any).jobs.size,0);assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),null);assert.deepEqual(p.writes,['trash-thread']);
  }finally{release.resolve();await Promise.allSettled([...(service as any).jobs.values()].map((j:any)=>j.result));await p.cleanup();}
});

test('HTTP distinguishes confirmed local restore from an unknown external result',async()=>{
  const p=await prepared();try{
    const service=p.make({unarchive:{run:async()=>({state:'unknown' as const})}}),app=new Hono().route('/api/trash',createStoredTrashRouter({port:p.port,service}));
    const response=await app.request(`http://localhost:9081/api/trash/projects/${project}/restore`,{method:'POST',headers:{cookie:serializeSessionCookie('synthetic-trash-owner',Date.now()+600000,false),origin:'http://localhost:9081'}});
    assert.equal(response.status,503);const value=await response.json();assert.equal(value.code,'RESTORE_EXTERNAL_UNKNOWN');assert.equal(p.f.scalar(`SELECT deleted_at FROM projects WHERE id='${project}'`),null);
  }finally{await p.cleanup();}
});

test('verification-only sibling leaves an unused dispatch right prepared when fresh proof is unavailable',async()=>{
  const p=await prepared();try{
    p.f.mutate(`UPDATE sessions SET engine='codex',codex_thread_id='trash-thread',codex_archived=1,codex_archived_for_trash=1 WHERE id='${child2}'`);
    const unarchive=new StoredUnarchiveService({port:p.port,storeId:'store',generation:1,isThreadArchived:async()=>p.writes.length?null:true,
      unarchiveThread:async(id,guard)=>{if(!await guard())throw new Error('changed');p.writes.push(id);},closeIdleConnection:()=>{},changed:()=>{}});
    assert.deepEqual(await p.make({unarchive}).restore(principal(),'project',project,randomUUID()),{state:'unknown',localCommitted:true});
    assert.deepEqual(p.writes,['trash-thread']);assert.equal(p.f.scalar(`SELECT phase FROM _relay_external_operations WHERE kind='unarchive' AND session_id='${child2}'`),'prepared');
  }finally{await p.cleanup();}
});
