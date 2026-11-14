import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import { RuntimeStorage } from './runtime-storage.js';

const principal={kind:'runtime' as const,sessionId:'session',attemptId:'attempt',connectionId:'connection',runtimeVersion:1};
async function setup(sql=''){
  const f=fixture();if(sql)f.mutate(sql);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const storage=new RuntimeStorage(port,{storeId:'store',generation:1,leaseToken:'lease',engineId:'codex',runtime:{},principal,isCurrent:()=>true,onFailure:()=>{}});
  return{f,port,storage,close:async()=>{await storage.close().catch(()=>{});await port.close();f.cleanup();}};
}
test('new Codex binding and receipt commit atomically, preserve metadata and replay once',async()=>{
  const h=await setup(`UPDATE sessions SET engine_session_id=NULL,engine_metadata='{"keep":true}'`);
  try{
    await h.storage.bindExternalSession(null,'new-thread');await h.storage.bindExternalSession(null,'new-thread');
    assert.equal(h.f.scalar('SELECT engine_session_id FROM sessions'),'new-thread');
    assert.equal(h.f.scalar('SELECT codex_thread_id FROM sessions'),'new-thread');
    assert.equal(h.f.scalar('SELECT engine_metadata FROM sessions'),'{"keep":true}');
    assert.equal(h.f.scalar("SELECT count(*) FROM _relay_storage_operations WHERE command_name='turn.bindExternalSession'"),1);
  }finally{await h.close();}
});
test('resume cannot silently replace an existing external session',async()=>{
  const h=await setup();try{
    await assert.rejects(h.storage.bindExternalSession('thread','replacement'));
    assert.equal(h.f.scalar('SELECT engine_session_id FROM sessions'),'thread');
    assert.equal(h.f.scalar('SELECT codex_thread_id FROM sessions'),null);
  }finally{await h.close();}
});
test('resume repairs the missing Codex alias only for the identical external session',async()=>{
  const h=await setup();try{await h.storage.bindExternalSession('thread','thread');assert.equal(h.f.scalar('SELECT codex_thread_id FROM sessions'),'thread');}finally{await h.close();}
});
test('stop, owner disable, deleted project, alias conflict and wrong lease engine refuse binding',async()=>{
  for(const sql of ["UPDATE sessions SET status='stopping'","UPDATE users SET disabled_at=1 WHERE id='owner'",
    "UPDATE projects SET deleted_at=1","UPDATE sessions SET codex_thread_id='another-thread'","UPDATE engine_resource_leases SET engine_id='zcode'"]){
    const h=await setup(sql);try{await assert.rejects(h.storage.bindExternalSession('thread','thread'));
      assert.equal(h.f.scalar("SELECT count(*) FROM _relay_storage_operations WHERE command_name='turn.bindExternalSession'"),0);
    }finally{await h.close();}
  }
});
test('unknown binding receipt never authorizes initialization or clears the runtime lease',async()=>{
  const h=await setup('UPDATE sessions SET engine_session_id=NULL');
  const execute=h.port.execute.bind(h.port);
  h.port.execute=(async(request:any)=>request.command.name==='turn.bindExternalSession'
    ?{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'}:execute(request)) as typeof h.port.execute;
  try{await assert.rejects(h.storage.bindExternalSession(null,'new-thread'),/RUNTIME_STORAGE_UNCONFIRMED/);
    assert.equal(h.f.scalar('SELECT engine_session_id FROM sessions'),null);assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
  }finally{await h.close();}
});
test('a lost committed reply is confirmed using the same operation receipt',async()=>{
  const h=await setup('UPDATE sessions SET engine_session_id=NULL');const execute=h.port.execute.bind(h.port);let writes=0;
  h.port.execute=(async(request:any)=>{const result=await execute(request);if(request.command.name!=='turn.bindExternalSession')return result;
    writes++;assert.equal(result.state,'committed');return{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'};
  }) as typeof h.port.execute;
  try{await h.storage.bindExternalSession(null,'new-thread');assert.equal(writes,1);assert.equal(h.f.scalar('SELECT codex_thread_id FROM sessions'),'new-thread');}finally{await h.close();}
});
test('receipt write failure rolls back both external identifiers',async()=>{
  const h=await setup('UPDATE sessions SET engine_session_id=NULL');
  h.f.mutate(`CREATE TRIGGER reject_binding BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='turn.bindExternalSession'
    BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;`);
  try{await assert.rejects(h.storage.bindExternalSession(null,'new-thread'));assert.equal(h.f.scalar('SELECT engine_session_id FROM sessions'),null);
    assert.equal(h.f.scalar('SELECT codex_thread_id FROM sessions'),null);
  }finally{await h.close();}
});
test('an external session already owned by another Relay session cannot be rebound',async()=>{
  const h=await setup(`UPDATE sessions SET engine_session_id=NULL;
    INSERT INTO sessions(id,owner_user_id,project_id,engine,engine_bound,engine_session_id,codex_thread_id) VALUES('sibling','owner','project','codex',1,'new-thread','new-thread')`);
  try{await assert.rejects(h.storage.bindExternalSession(null,'new-thread'));assert.equal(h.f.scalar("SELECT engine_session_id FROM sessions WHERE id='session'"),null);}finally{await h.close();}
});
