import test from 'node:test';
import assert from 'node:assert/strict';
import { StoredRuntimeEvents } from './stored-runtime-events.js';
import { createSessionRuntimeState } from './runtime.js';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import type { EngineEventEnvelope } from './events.js';

const event=(turnId='turn'):EngineEventEnvelope=>({engineId:'codex',payload:{type:'turn_start',turnId},
  meta:{source:'realtime',sequence:1,observedAt:100,eventId:`start:${turnId}`,externalSessionId:'thread',externalTurnId:turnId}});
async function setup(sql=''){
  const f=fixture();f.mutate("UPDATE engine_resource_leases SET state='claimed',started_at=NULL;UPDATE sessions SET status='pending'");if(sql)f.mutate(sql);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const runtime=createSessionRuntimeState({sessionId:'session',projectId:'project',engine:'codex'});
  runtime.attemptId='attempt';runtime.engineConnectionId='connection';runtime.leaseToken='lease';
  let owned=true;const bound=new StoredRuntimeEvents(runtime,port,{storeId:'store',generation:1,runtimeVersion:1,isOwned:()=>owned,onFailure:()=>{}});
  return{f,port,runtime,bound,retire:()=>{owned=false;},close:async()=>{await bound.close().catch(()=>{});await port.close();f.cleanup();}};
}
test('running lease, turn identity, capacity and receipt are committed before observers or publication',async()=>{
  const h=await setup();try{
    h.runtime.observeEngineEvent=async()=>{assert.equal(h.f.scalar('SELECT state FROM engine_resource_leases'),'running');};
    let published=0;
    for(let i=0;i<2;i++)await h.bound.route(event(),()=>{
      published++;assert.equal(h.f.scalar('SELECT active_turn_id FROM sessions'),'turn');
      assert.equal(h.f.scalar('SELECT status FROM sessions'),'processing');assert.equal(h.runtime.currentTurnId,'turn');
    });
    assert.equal(published,2);assert.equal(h.f.scalar('SELECT count(*) FROM engine_turn_facts'),1);
    assert.equal(h.f.scalar("SELECT count(*) FROM engine_capacity_events WHERE event_type='start_accepted'"),1);
    assert.equal(h.f.scalar("SELECT count(*) FROM _relay_storage_operations WHERE command_name='turn.projectStarted'"),1);
    assert.equal(h.f.scalar('SELECT active_turn_started_at FROM sessions'),h.runtime.turnStartTime);
  }finally{await h.close();}
});
test('a delayed live start preserves stopping and awaiting_action instead of overwriting them',async()=>{
  for(const status of ['stopping','awaiting_action']){const h=await setup(`UPDATE sessions SET status='${status}'`);
    try{await h.bound.route(event(),()=>{assert.equal(h.f.scalar('SELECT status FROM sessions'),status);});assert.equal(h.f.scalar('SELECT state FROM engine_resource_leases'),'running');assert.equal(h.runtime.isStopping,status==='stopping');}finally{await h.close();}
  }
});
test('a historical start is recorded without opening or publishing a live turn',async()=>{
  const h=await setup();try{await h.bound.route({...event(),meta:{...event().meta,source:'history'}},()=>assert.fail('history must not be published as live'));
    assert.equal(h.f.scalar('SELECT count(*) FROM engine_turn_facts'),1);assert.equal(h.f.scalar('SELECT active_turn_id FROM sessions'),null);
    assert.equal(h.f.scalar('SELECT state FROM engine_resource_leases'),'claimed');
  }finally{await h.close();}
});
test('durable stop intent wins even if an intervening projection reset the status',async()=>{
  const h=await setup();try{
    const result=await h.port.execute({protocolVersion:1,storeId:'store',workerGeneration:1,requestId:'stop-rpc',operationId:'stop-op',
      principal:{kind:'user',userId:'owner',authSessionHash:'auth-owner'},command:{name:'turn.requestStop',input:{sessionId:'session',expectedAttemptId:'attempt'}}});
    assert.equal(result.state,'committed');h.f.mutate("UPDATE sessions SET status='pending'");
    await h.bound.route(event(),()=>{assert.equal(h.f.scalar('SELECT status FROM sessions'),'stopping');assert.equal(h.runtime.isStopping,true);});
    assert.equal(h.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
  }finally{await h.close();}
});
test('a different turn cannot overwrite a turn already running for the same attempt',async()=>{
  const h=await setup();try{await h.bound.route(event(),()=>{});await assert.rejects(h.bound.route(event('replacement'),()=>assert.fail('must not publish replacement')));
    assert.equal(h.f.scalar('SELECT active_turn_id FROM sessions'),'turn');assert.equal(h.runtime.currentTurnId,'turn');
  }finally{await h.close();}
});
test('a mismatched external session or payload turn cannot authorize the start projection',async()=>{
  for(const meta of [{externalSessionId:'another-thread'},{externalTurnId:'another-turn'}]){
    const h=await setup();try{await assert.rejects(h.bound.route({...event(),meta:{...event().meta,...meta}},()=>assert.fail('must not publish mismatched evidence')));
      assert.equal(h.f.scalar('SELECT state FROM engine_resource_leases'),'claimed');assert.equal(h.f.scalar('SELECT active_turn_id FROM sessions'),null);
    }finally{await h.close();}
  }
});
test('receipt transaction failure rolls back running state, identity and capacity; fact remains',async()=>{
  const h=await setup();h.f.mutate(`CREATE TRIGGER reject_start BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='turn.projectStarted'
    BEGIN SELECT RAISE(ABORT,'synthetic start failure'); END;`);
  try{await assert.rejects(h.bound.route(event(),()=>assert.fail('uncommitted start must not publish')));
    assert.equal(h.f.scalar('SELECT count(*) FROM engine_turn_facts'),1);assert.equal(h.f.scalar('SELECT state FROM engine_resource_leases'),'claimed');
    assert.equal(h.f.scalar('SELECT active_turn_id FROM sessions'),null);assert.equal(h.f.scalar('SELECT count(*) FROM engine_capacity_events'),0);
    assert.equal(h.runtime.currentTurnId,null);
  }finally{await h.close();}
});
test('a lost committed start reply uses its receipt while unknown start without receipt cannot publish',async()=>{
  for(const commit of [true,false]){const h=await setup(),execute=h.port.execute.bind(h.port);let startedWrites=0;
    h.port.execute=(async(request:any)=>{if(request.command.name!=='turn.projectStarted')return execute(request);
      startedWrites++;if(commit)assert.equal((await execute(request)).state,'committed');
      return{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'};
    }) as typeof h.port.execute;
    try{let published=0;const pending=h.bound.route(event(),()=>{published++;});if(commit)await pending;else await assert.rejects(pending);
      assert.equal(startedWrites,1);assert.equal(published,Number(commit));assert.equal(h.f.scalar('SELECT state FROM engine_resource_leases'),commit?'running':'claimed');
    }finally{await h.close();}
  }
});
test('retiring the runtime during a committed start await suppresses late publication and mutation',async()=>{
  const h=await setup(),execute=h.port.execute.bind(h.port);
  h.port.execute=(async(request:any)=>{const result=await execute(request);if(request.command.name==='turn.projectStarted')h.retire();return result;}) as typeof h.port.execute;
  try{assert.deepEqual(await h.bound.route(event(),()=>assert.fail('old runtime must not publish')),{state:'stale'});
    assert.equal(h.f.scalar('SELECT state FROM engine_resource_leases'),'running');assert.equal(h.runtime.currentTurnId,null);
  }finally{await h.close();}
});
