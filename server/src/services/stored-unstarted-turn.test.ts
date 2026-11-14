import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,markRead } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StoredProviderTurnScheduler } from '../engine/concurrency/stored-scheduler.js';
import { StoredUnstartedTurnFailure } from './stored-unstarted-turn.js';
import type { QueueClaim,StoragePrincipal } from '../storage/contracts.js';
const key='codex:default';
async function setup(){const f=fixture();f.mutate('DELETE FROM engine_resource_leases');const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true,defaultConcurrency:{[key]:1}});
  assert.equal((await port.execute({...markRead(),operationId:'enqueue',command:{name:'turn.enqueue',input:{sessionId:'draft',attemptId:'attempt',messageId:'message',engineId:'codex',resourceKey:key,
    content:'original user input',metadata:null,expectedPreferencesRevision:0,origin:{kind:'direct'},draft:{projectId:'project',title:'test',titleManuallySet:false}}}})).state,'committed');
  let scheduler:StoredProviderTurnScheduler|undefined,commits=0,unknown=0;
  const handler=new StoredUnstartedTurnFailure(port,{storeId:'store',generation:1,assertExclusiveWriter:async()=>{},committed:async()=>{commits++;},unconfirmed:()=>{unknown++;}});
  return{f,port,handler,get commits(){return commits;},get unknown(){return unknown;},make:(start:ConstructorParameters<typeof StoredProviderTurnScheduler>[1]['start'])=>{
    scheduler=new StoredProviderTurnScheduler(port,{storeId:'store',generation:1,assertExclusiveWriter:async()=>{},onFailure:()=>{},start,failed:(claim,error,context)=>handler.handle(claim,error,context)});return scheduler;},
    cleanup:async()=>{await scheduler?.close();await port.close();f.cleanup();}};
}

test('a proven unstarted preparation failure atomically preserves user content and saves a real failed result',async()=>{
  const p=await setup();try{await p.make(async()=>{throw Object.assign(Error('connect ECONNREFUSED token=private-preparation-secret at C:\\private\\config.json'),{code:'ECONNREFUSED'});}).drain(key);
    assert.equal(p.commits,1);assert.equal(p.f.scalar("SELECT status FROM sessions WHERE id='draft'"),'failed');assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
    assert.equal(p.f.scalar("SELECT content FROM messages WHERE id='message'"),'original user input');
    assert.equal(p.f.scalar("SELECT count(*) FROM messages WHERE session_id='draft' AND role='assistant'"),1);
    assert.equal(p.f.scalar("SELECT count(*) FROM messages WHERE content LIKE '%private-preparation-secret%' OR content LIKE '%private%config.json%'"),0);
    const assistant=String(p.f.scalar("SELECT content FROM messages WHERE role='assistant' AND session_id='draft'"));
    assert.match(assistant,/ECONNREFUSED/);assert.match(assistant,/REDACTED/);assert.match(assistant,/PATH/);
    assert.equal(p.f.scalar("SELECT reason_code FROM engine_terminal_decisions WHERE session_id='draft'"),'TURN_PREPARATION_ENGINE_UNAVAILABLE');
    assert.equal(p.f.scalar("SELECT count(*) FROM engine_turn_facts WHERE fact_type='engine_error'"),1);
  }finally{await p.cleanup();}
});

test('a stop during preparation settles locally only after the scheduler proves no actual engine effect began',async()=>{
  const p=await setup();try{await p.make(async()=>{
    assert.equal((await p.port.execute({...markRead('read','admin'),operationId:'stop',command:{name:'turn.requestStop',input:{sessionId:'draft',expectedAttemptId:'attempt'}}})).state,'committed');throw Error('preparation cancelled before any RPC');
  }).drain(key);
    assert.equal(p.f.scalar("SELECT status FROM sessions WHERE id='draft'"),'stopped');assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
    assert.equal(p.f.scalar("SELECT count(*) FROM engine_turn_facts WHERE fact_type='interrupt_confirmed'"),1);assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='succeeded'"),1);
  }finally{await p.cleanup();}
});

test('an ambiguous actual engine effect never enters the unstarted terminal path',async()=>{
  const p=await setup();try{await p.make(async(_claim,context)=>{await context.dispatch(()=>{throw Error('unknown engine reply');});}).drain(key);
    assert.equal(p.unknown,1);assert.equal(p.commits,0);assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);assert.equal(p.f.scalar('SELECT count(*) FROM engine_terminal_decisions'),0);
  }finally{await p.cleanup();}
});

test('a claimed turn can finish locally after account disable without acquiring start permission',async()=>{
  const p=await setup();try{await p.make(async()=>{p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");throw Error('revoked before dispatch');}).drain(key);
    assert.equal(p.f.scalar("SELECT status FROM sessions WHERE id='draft'"),'failed');assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
  }finally{await p.cleanup();}
});

test('a lost terminal receipt rolls back fact, result, queue, probe release and lease together',async()=>{
  const p=await setup();let claim:QueueClaim|undefined;try{p.f.mutate(`INSERT INTO engine_provider_cooldowns VALUES('${key}',1,1,NULL,1,NULL,1)`);
    p.f.mutate("CREATE TRIGGER fail_unstarted BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='queue.finishUnstarted' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    await p.make(async(value)=>{claim=value;throw Error('not started');}).drain(key);assert.equal(p.commits,0);assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);assert.equal(p.f.scalar("SELECT count(*) FROM engine_turn_facts"),0);assert.equal(p.f.scalar("SELECT probe_attempt_id FROM engine_provider_cooldowns"),'attempt');
    p.f.mutate('DROP TRIGGER fail_unstarted');await p.handler.handle(claim!,Error('same known unstarted attempt'),{effectStarted:false});assert.equal(p.commits,1);assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);assert.equal(p.f.scalar('SELECT probe_attempt_id FROM engine_provider_cooldowns'),null);
    await p.handler.handle(claim!,Error('same proven unstarted attempt'),{effectStarted:false});assert.equal(p.f.scalar("SELECT count(*) FROM messages WHERE session_id='draft' AND role='assistant'"),1);
  }finally{await p.cleanup();}
});

test('changed lease, running lease or a stopping state without durable intent refuse local fabrication',async()=>{
  for(const sql of ["UPDATE engine_resource_leases SET lease_token='other'","UPDATE engine_resource_leases SET state='running'","UPDATE sessions SET status='stopping' WHERE id='draft'"]){
    const p=await setup();try{await p.make(async()=>{p.f.mutate(sql);throw Error('changed source');}).drain(key);assert.equal(p.commits,0);assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);assert.equal(p.f.scalar('SELECT count(*) FROM engine_terminal_decisions'),0);
    }finally{await p.cleanup();}
  }
});

test('browser and maintenance callers cannot assert that a claimed turn never started',async()=>{
  const p=await setup();try{let saved:QueueClaim|undefined;await p.make(async(claim,context)=>{saved=claim;await context.dispatch(()=>undefined);}).drain(key);
    for(const principal of [markRead().principal,{kind:'system',purpose:'maintenance'} as StoragePrincipal]){
      await assert.rejects(p.port.execute({protocolVersion:1,storeId:'store',workerGeneration:1,requestId:'invalid',operationId:'invalid',principal,
        command:{name:'queue.finishUnstarted',input:{claim:saved!,messageId:'bad'}}}),{code:'FORBIDDEN'});
    }
    assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
  }finally{await p.cleanup();}
});
