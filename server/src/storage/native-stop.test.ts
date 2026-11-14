import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,markRead } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import type { CoreCommandInputs,CoreCommandName,StorageCommandEnvelope,StoragePrincipal } from './contracts.js';
const runtime={kind:'runtime',sessionId:'session',attemptId:'attempt',connectionId:'connection',runtimeVersion:1} as const;
function command<K extends CoreCommandName>(operationId:string,name:K,input:CoreCommandInputs[K],principal:StoragePrincipal=markRead().principal){
  return{...markRead(),operationId,principal,command:{name,input}} as StorageCommandEnvelope&{command:{name:K;input:CoreCommandInputs[K]}};
}
const stop=(operationId='stop',actor='owner',attempt='attempt')=>command(operationId,'turn.requestStop',{sessionId:'session',expectedAttemptId:attempt},markRead('read',actor).principal);
async function prepared(){const f=fixture(),port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  await port.registerRuntime({storeId:'store',workerGeneration:1,leaseToken:'lease',runtime});
  return{f,port,check:(operationId='stop',actor='owner')=>port.checkStopDispatch({principal:markRead('read',actor).principal as Extract<StoragePrincipal,{kind:'user'}>,operationId,runtime}),
    cleanup:async()=>{await port.close();f.cleanup();}};
}
async function terminal(port:StorageWorkerClient,outcome:'stopped'|'failed'='stopped'){
  const fact={id:'stop-fact',sessionId:'session',attemptId:'attempt',engineId:'codex' as const,connectionId:'connection',
    factType:outcome==='stopped'?'interrupt_confirmed' as const:'engine_error' as const,source:'local' as const,sequence:1,idempotencyKey:'stop-fact-key',observedAt:100,
    payload:outcome==='stopped'?{userInitiated:true}:{errorCode:'SYNTHETIC',retryable:false}};
  assert.equal((await port.execute(command('fact','turn.appendFact',{fact},runtime))).state,'committed');
  return port.execute(command('terminal','turn.projectTerminal',{decision:{id:'decision',sessionId:'session',attemptId:'attempt',engineId:'codex',
    outcome,reasonCode:outcome==='stopped'?'USER_STOPPED':'SYNTHETIC',factId:'stop-fact',decidedAt:100,projectedAt:null},message:{id:'stopped-message',turnId:'attempt',content:'',items:null,metadata:null,durationMs:1}},runtime));
}

test('a committed stop intent fences dispatch without fabricating a stopped result or releasing the lease',async()=>{
  const p=await prepared();try{const result=await p.port.execute(stop());assert.equal(result.state,'committed');if(result.state==='committed')assert.equal(result.value.requested,true);
    assert.equal(p.f.scalar('SELECT status FROM sessions'),'stopping');assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);assert.equal(p.f.scalar('SELECT count(*) FROM engine_terminal_decisions'),0);
    assert.equal(await p.check(),true);const replay=await p.port.execute(stop());assert.equal(replay.state,'committed');if(replay.state==='committed')assert.equal(replay.replayed,true);
    p.f.mutate("UPDATE sessions SET status='processing'");const duplicate=await p.port.execute(stop('other-operation'));assert.equal(duplicate.state,'committed');if(duplicate.state==='committed')assert.equal(duplicate.value.requested,false);
    assert.equal(p.f.scalar('SELECT status FROM sessions'),'stopping');assert.equal(p.f.scalar('SELECT count(*) FROM admin_audit_events'),0);
  }finally{await p.cleanup();}
});

test('stop refuses another attempt and another account without affecting current work',async()=>{
  const p=await prepared();try{assert.equal((await p.port.execute(stop('wrong-attempt','owner','next'))).state,'rejected');const forbidden=await p.port.execute(stop('other-user','other'));assert.equal(forbidden.state,'rejected');if(forbidden.state==='rejected')assert.equal(forbidden.code,'FORBIDDEN');
    assert.equal(p.f.scalar('SELECT status FROM sessions'),'processing');assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
  }finally{await p.cleanup();}
});

test('stop intent and administrator start audit roll back if their receipt cannot commit',async()=>{
  const p=await prepared();try{p.f.mutate("CREATE TRIGGER fail_stop BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='turn.requestStop' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    assert.equal((await p.port.execute(stop('stop','admin'))).state,'unknown');assert.equal(p.f.scalar('SELECT status FROM sessions'),'processing');assert.equal(p.f.scalar('SELECT count(*) FROM admin_audit_events'),0);
    assert.equal((await p.port.lookup({storeId:'store',operationId:'stop',principal:markRead('read','admin').principal})).state,'not-found');
  }finally{await p.cleanup();}
});

test('administrator stop audits success only with the committed actual stopped terminal',async()=>{
  const p=await prepared();try{assert.equal((await p.port.execute(stop('stop','admin'))).state,'committed');assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='started'"),1);assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='succeeded'"),0);
    assert.equal(await p.check('stop','admin'),true);assert.equal((await terminal(p.port)).state,'committed');assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='succeeded'"),1);assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
    await assert.rejects(p.check('stop','admin'),{code:'FORBIDDEN'});
  }finally{await p.cleanup();}
});

test('terminal audit failure rolls back result projection, lease release and revision together',async()=>{
  const p=await prepared();try{await p.port.execute(stop('stop','admin'));p.f.mutate("CREATE TRIGGER fail_stop_audit BEFORE INSERT ON admin_audit_events WHEN NEW.result='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    assert.equal((await terminal(p.port)).state,'unknown');assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);assert.equal(p.f.scalar('SELECT status FROM sessions'),'stopping');assert.equal(p.f.scalar('SELECT message_revision FROM sessions'),2);assert.equal(p.f.scalar("SELECT count(*) FROM messages WHERE id='stopped-message'"),0);
    p.f.mutate('DROP TRIGGER fail_stop_audit');assert.equal((await terminal(p.port)).state,'committed');assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='succeeded'"),1);
  }finally{await p.cleanup();}
});

test('a failed actual terminal closes an admin stop audit as failed rather than succeeded',async()=>{
  const p=await prepared();try{await p.port.execute(stop('stop','admin'));assert.equal((await terminal(p.port,'failed')).state,'committed');assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='failed'"),1);assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='succeeded'"),0);
  }finally{await p.cleanup();}
});

test('late stop guards reject expired login, replaced runtime, demoted admin and a newer active attempt',async()=>{
  for(const sql of ["UPDATE auth_sessions SET expires_at=1 WHERE user_id='admin'","UPDATE users SET role='member' WHERE id='admin'","UPDATE sessions SET active_attempt_id='next'","UPDATE engine_resource_leases SET lease_token='new'"]){
    const p=await prepared();try{await p.port.execute(stop('stop','admin'));p.f.mutate(sql);let allowed=false;try{allowed=await p.check('stop','admin');}catch{}assert.equal(allowed,false);
      assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
    }finally{await p.cleanup();}
  }
});

test('retiring the registered runtime invalidates an otherwise matching stop receipt',async()=>{
  const p=await prepared();try{await p.port.execute(stop());await p.port.retireRuntime({storeId:'store',workerGeneration:1,runtime});await assert.rejects(p.check(),{code:'FORBIDDEN'});
  }finally{await p.cleanup();}
});
