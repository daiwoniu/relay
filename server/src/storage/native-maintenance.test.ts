import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeStore } from './native-store.js';
import { fixture, markRead } from './storage-fixture.test-support.js';
import { assertMaintenanceAdmission } from './native-maintenance-fence.js';
import { nativeQueries } from './native-queries.js';
import { DatabaseSync } from 'node:sqlite';

test('maintenance accounts for unknown provider forks, unarchives, archives and compensations',()=>{
  const f=fixture(),store=new NativeStore(f.filename,'store',1,true);
  try{
    f.mutate(`UPDATE sessions SET status='idle';DELETE FROM engine_resource_leases;
      INSERT INTO _relay_external_operations VALUES('fork','fork','owner','session','digest','thread','dispatched',1,1);
      INSERT INTO _relay_external_operations VALUES('unarchive','unarchive','owner','missing','digest','thread','dispatched',1,1);
      INSERT INTO _relay_soft_delete_jobs VALUES('delete','session','session','project','owner','owner','digest','prepared',1,1);
      INSERT INTO _relay_trash_archives VALUES('delete','thread','dispatched',NULL,NULL,NULL,NULL);
      INSERT INTO _relay_trash_compensations VALUES('delete','thread','dispatched',NULL,NULL);`);
    const read=()=>store.readMaintenanceState({principal:{kind:'system',purpose:'maintenance'}});
    assert.equal(read().activeTasks,4);assert.equal(read().byEngine.codex,4);
    f.mutate("UPDATE _relay_external_operations SET phase='applied';UPDATE _relay_trash_archives SET phase='confirmed';UPDATE _relay_trash_compensations SET phase='confirmed'");
    assert.equal(read().activeTasks,0);
  }finally{store.close();f.cleanup();}
});

test('engine-scoped maintenance fences all provider dispatch claims while allowing terminal evidence',()=>{
  const f=fixture(),store=new NativeStore(f.filename,'store',1,true),db=new DatabaseSync(f.filename);
  try{
    f.mutate("INSERT INTO _relay_maintenance_fence VALUES(1,'maintenance','codex',1)");
    const commands=['session.prepareFork','session.claimFork','session.prepareUnarchive','session.claimUnarchive','trash.claimTrashArchive','trash.claimTrashRestore'];
    for(const name of commands)assert.throws(()=>assertMaintenanceAdmission(nativeQueries(db),{name,input:{sessionId:'session'}} as any),/CONFLICT/);
    assert.doesNotThrow(()=>assertMaintenanceAdmission(nativeQueries(db),{name:'session.finishUnarchive',input:{sessionId:'session'}} as any));
    f.mutate("UPDATE _relay_maintenance_fence SET engine_id='codebuddy'");
    for(const name of commands)assert.doesNotThrow(()=>assertMaintenanceAdmission(nativeQueries(db),{name,input:{sessionId:'session'}} as any));
  }finally{db.close();store.close();f.cleanup();}
});

test('maintenance reads current task ownership, deduplicates sessions and retains orphan leases',()=>{
  const f=fixture(),store=new NativeStore(f.filename,'store',1,true);
  try{
    const read=()=>store.readMaintenanceState({principal:{kind:'system',purpose:'maintenance'}});
    assert.deepEqual(read(),{activeTasks:1,queuedTasks:0,pendingFollowups:0,byEngine:{codex:1,codebuddy:0,opencode:0,zcode:0},projectRoots:['D:/synthetic'],fence:null});
    f.mutate("UPDATE sessions SET status='idle';INSERT INTO engine_resource_leases VALUES('orphan','missing','orphan-lease','claimed','codebuddy','codebuddy:default',1,NULL)");
    assert.equal(read().activeTasks,2);assert.equal(read().byEngine.codebuddy,1);
    f.mutate("DELETE FROM engine_resource_leases;UPDATE projects SET deleted_at=1");
    assert.equal(read().activeTasks,0);assert.deepEqual(read().projectRoots,[]);
    assert.throws(()=>store.readMaintenanceState({principal:{kind:'system',purpose:'recovery'}} as any),/FORBIDDEN/);
    assert.throws(()=>store.readMaintenanceState({principal:markRead().principal} as any),/FORBIDDEN/);
  }finally{store.close();f.cleanup();}
});

test('durable maintenance fences order new sends and queue claims and survive reopen without touching accepted work',()=>{
  const f=fixture();let store=new NativeStore(f.filename,'store',1,true);
  const execute=(operationId:string,name:string,input:any,principal:any={kind:'system',purpose:'maintenance'})=>store.execute({...markRead(),operationId,principal,command:{name,input}});
  try{
    assert.equal(execute('fence','maintenance.acquire',{fenceId:'cutover',engineId:'codex'}).state,'committed');
    assert.equal(execute('fence','maintenance.acquire',{fenceId:'cutover',engineId:'codex'}).state,'committed');
    const send=()=>execute('late-send','turn.enqueue',{sessionId:'draft',attemptId:'new',messageId:'new-message',engineId:'codex',resourceKey:'codex:default',content:'late prepared send',metadata:null,expectedPreferencesRevision:0,origin:{kind:'direct'},draft:{projectId:'project',title:'draft',titleManuallySet:false}},markRead().principal);
    assert.deepEqual(send(),{state:'rejected',operationId:'late-send',code:'CONFLICT'});assert.equal(f.scalar("SELECT COUNT(*) FROM sessions WHERE id='draft'"),0);
    assert.equal(execute('claim','queue.claim',{resourceKey:'codex:default',claimToken:'claim'},{kind:'system',purpose:'scheduler'}).state,'rejected');
    assert.equal(f.scalar('SELECT COUNT(*) FROM engine_resource_leases'),1,'existing task ownership remains available to finish');
    assert.equal(execute('wrong-release','maintenance.release',{fenceId:'other'}).state,'rejected');
    store.close();store=new NativeStore(f.filename,'store',1);assert.equal(send().state,'rejected');
    assert.equal(execute('release','maintenance.release',{fenceId:'cutover'}).state,'committed');assert.equal(send().state,'committed');
    assert.equal(execute('after-send','maintenance.acquire',{fenceId:'global',engineId:null}).state,'committed');
    assert.equal(execute('other-claim','queue.claim',{resourceKey:'codebuddy:default',claimToken:'claim'},{kind:'system',purpose:'scheduler'}).state,'rejected');
  }finally{store.close();f.cleanup();}
});

test('maintenance fence changes and their receipts share one transaction and reject non-supervisor callers',()=>{
  const f=fixture(),store=new NativeStore(f.filename,'store',1,true);
  const request={...markRead(),operationId:'fence',principal:{kind:'system' as const,purpose:'maintenance' as const},command:{name:'maintenance.acquire' as const,input:{fenceId:'cutover',engineId:null}}};
  try{
    assert.throws(()=>store.execute({...request,principal:markRead().principal}),/FORBIDDEN/);
    f.mutate("CREATE TRIGGER stop_fence_receipt BEFORE INSERT ON _relay_storage_operations BEGIN SELECT RAISE(ABORT,'synthetic');END");
    assert.equal(store.execute(request).state,'unknown');assert.equal(f.scalar('SELECT COUNT(*) FROM _relay_maintenance_fence'),0);
    f.mutate('DROP TRIGGER stop_fence_receipt');assert.equal(store.execute(request).state,'committed');
  }finally{store.close();f.cleanup();}
});
