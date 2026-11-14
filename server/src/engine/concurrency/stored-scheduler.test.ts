import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,markRead } from '../../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../../storage/worker-client.js';
import type { CoreCommandName,CoreStoragePort,QueueClaim,StorageCommandEnvelope,CommandResult } from '../../storage/contracts.js';
import { StoredProviderTurnScheduler,type StoredDispatchContext,type StoredSchedulerOptions } from './stored-scheduler.js';

const principal={kind:'system',purpose:'scheduler'} as const,key='codex:default';
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};};
async function prepared(){
  const f=fixture();f.mutate('DELETE FROM engine_resource_leases');
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true,defaultConcurrency:{[key]:2}});
  const services:StoredProviderTurnScheduler[]=[];
  return{f,port,make:(options:Partial<StoredSchedulerOptions>={},custom:CoreStoragePort=port)=>{
    const service=new StoredProviderTurnScheduler(custom,{storeId:'store',generation:1,assertExclusiveWriter:async()=>{},
      start:async()=>{throw Error('unexpected engine start');},failed:async()=>{},onFailure:()=>{},...options});services.push(service);return service;},
    enqueue:async(suffix='',actor='owner')=>{const result=await port.execute({...markRead('read',actor),operationId:'enqueue'+suffix,command:{name:'turn.enqueue',input:{
      sessionId:'draft'+suffix,attemptId:'attempt'+suffix,messageId:'message'+suffix,engineId:'codex',resourceKey:key,content:'synthetic',metadata:null,
      expectedPreferencesRevision:0,origin:{kind:'direct'},draft:{projectId:'project',title:'test',titleManuallySet:false}}}});assert.equal(result.state,'committed');},
    cleanup:async()=>{await Promise.all(services.map(s=>s.close()));await port.close();f.cleanup();}};
}
function proxy(port:CoreStoragePort,overrides:Partial<Omit<CoreStoragePort,'execute'>>&{execute?:(request:StorageCommandEnvelope)=>Promise<CommandResult<CoreCommandName>>}):CoreStoragePort{
  return new Proxy(port,{get(target,key){const value=Reflect.get(overrides,key)??Reflect.get(target,key);return typeof value==='function'?value.bind(Reflect.has(overrides,key)?overrides:target):value;}});
}

test('native scheduler claims atomically and a one-shot dispatch never duplicates claim capacity events',async()=>{
  const p=await prepared();try{await p.enqueue();await p.enqueue('-2');let starts=0,escaped:StoredDispatchContext|undefined;
    const service=p.make({start:async(_claim,context)=>{escaped=context;await context.dispatch(()=>{starts++;});await assert.rejects(context.dispatch(()=>{starts++;}),{code:'CONFLICT'});}});
    await service.drain(key);assert.equal(starts,2);assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),2);
    assert.equal(p.f.scalar("SELECT count(*) FROM engine_capacity_events WHERE event_type='start_claimed'"),2);
    await assert.rejects(escaped!.dispatch(()=>{starts++;}),{code:'CONFLICT'});await service.drain(key);assert.equal(starts,2);
  }finally{await p.cleanup();}
});

test('fresh dispatch refuses changed lease, stopped session, disabled requester and changed ownership',async()=>{
  for(const mutation of ["UPDATE engine_resource_leases SET lease_token='replacement' WHERE session_id='draft'","UPDATE sessions SET status='stopping' WHERE id='draft'","UPDATE users SET disabled_at=1 WHERE id='owner'","UPDATE sessions SET owner_user_id='other' WHERE id='draft'"]){
    const p=await prepared();try{await p.enqueue();let starts=0;const failures:boolean[]=[];
      await p.make({start:async(_claim,context)=>{p.f.mutate(mutation);await context.dispatch(()=>{starts++;});},failed:async(_claim,_error,context)=>{failures.push(context.effectStarted);}}).drain(key);
      assert.equal(starts,0);assert.deepEqual(failures,[false]);assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
    }finally{await p.cleanup();}
  }
});

test('a former administrator cannot dispatch another owner\'s claimed turn after demotion',async()=>{
  const p=await prepared();try{await p.enqueue('','admin');p.f.mutate("UPDATE sessions SET owner_user_id='owner' WHERE id='draft'");let starts=0;
    await p.make({start:async(_claim,context)=>{p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");await context.dispatch(()=>{starts++;});}}).drain(key);
    assert.equal(starts,0);assert.equal(p.f.scalar("SELECT state FROM engine_queue_entries WHERE session_id='draft'"),'claimed');
  }finally{await p.cleanup();}
});

test('unknown claim uses the exact receipt before dispatch and never repeats a submitted claim',async()=>{
  const p=await prepared();try{await p.enqueue();let claims=0,starts=0;const custom=proxy(p.port,{execute:async(request)=>{
    const result=await p.port.execute<CoreCommandName>(request);if(request.command.name==='queue.claim'){claims++;if(claims===1)return{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'};}return result;
  }});const service=p.make({start:async(_claim,context)=>{await context.dispatch(()=>{starts++;});}},custom);
    await service.drain(key);assert.equal(starts,0);assert.equal(claims,1);await service.drain(key);assert.equal(starts,1);assert.equal(claims,2);
    assert.equal(p.f.scalar("SELECT count(*) FROM engine_capacity_events WHERE event_type='start_claimed'"),1);
  }finally{await p.cleanup();}
});

test('an unknown claim without a durable receipt blocks that resource instead of claiming again',async()=>{
  const p=await prepared();try{await p.enqueue();let claims=0;const custom=proxy(p.port,{execute:async(request)=>{claims++;return{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'};}}),service=p.make({},custom);
    await service.drain(key);await service.drain(key);assert.equal(claims,1);assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
    await assert.rejects(service.drain('unsupported'),{code:'NOT_SUPPORTED'});
  }finally{await p.cleanup();}
});

test('cooldown is read-only while blocked and expiry admits only the native atomic probe',async()=>{
  const p=await prepared();try{await p.enqueue();await p.enqueue('-2');p.f.mutate(`INSERT INTO engine_provider_cooldowns VALUES('${key}',1,${Date.now()+60000},NULL,1,NULL,1)`);let starts=0;
    const service=p.make({start:async(_claim,context)=>{await context.dispatch(()=>{starts++;});}});await service.drain(key);assert.equal(starts,0);
    p.f.mutate('UPDATE engine_provider_cooldowns SET cooldown_until=1');await service.drain(key);assert.equal(starts,1);assert.equal(p.f.scalar('SELECT probe_attempt_id FROM engine_provider_cooldowns'),'attempt');
    assert.equal(p.f.scalar("SELECT count(*) FROM engine_capacity_events WHERE event_type='start_claimed'"),1);
  }finally{await p.cleanup();}
});

test('close aborts preparation and waits for the actual accepted engine promise',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{await p.enqueue();let starts=0,aborted=false;
    const service=p.make({start:async(_claim,context)=>{context.signal.addEventListener('abort',()=>{aborted=true;});entered.resolve();await release.promise;await context.dispatch(()=>{starts++;});}}),run=service.drain(key);await entered.promise;
    let closed=false;const closing=service.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);release.resolve();await run;await closing;assert.equal(starts,0);assert.equal(aborted,true);
    await assert.rejects(service.drain(key),{code:'STORAGE_UNAVAILABLE'});
  }finally{release.resolve();await p.cleanup();}
});

test('unawaited engine effects remain owned and an ambiguous engine failure is never requeued',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{await p.enqueue();let failure:boolean|undefined;
    const service=p.make({start:async(_claim,context)=>{void context.dispatch(async()=>{entered.resolve();await release.promise;throw Error('lost engine reply');});},failed:async(_claim,_error,context)=>{failure=context.effectStarted;}}),run=service.drain(key);await entered.promise;
    let done=false;void run.then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);release.resolve();await run;assert.equal(failure,true);
    assert.equal(p.f.scalar("SELECT state FROM engine_queue_entries WHERE session_id='draft'"),'claimed');assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
  }finally{release.resolve();await p.cleanup();}
});

test('private scheduler queries reject browser identities and do not authorize a stale running claim',async()=>{
  const p=await prepared();try{await p.enqueue();await assert.rejects(p.port.readSchedulerState({principal:markRead().principal as any,resourceKey:key}),{code:'INVALID_ARGUMENT'});
    let selected:QueueClaim|undefined;await p.make({start:async(claim,context)=>{selected=claim;await context.dispatch(()=>undefined);}}).drain(key);
    assert.equal(await p.port.checkQueueDispatch({principal,claim:selected!}),true);
    p.f.mutate("UPDATE engine_resource_leases SET state='running' WHERE session_id='draft'");assert.equal(await p.port.checkQueueDispatch({principal,claim:selected!}),false);
  }finally{await p.cleanup();}
});

test('shutdown waits for an engine effect already in flight and cannot start a second queued task',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{await p.enqueue();await p.enqueue('-2');let starts=0;
    const service=p.make({start:async(_claim,context)=>{await context.dispatch(async()=>{starts++;entered.resolve();await release.promise;});}}),run=service.drain(key);await entered.promise;
    let closed=false;const closing=service.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);release.resolve();await closing;await run;
    assert.equal(starts,1);assert.equal(p.f.scalar("SELECT state FROM engine_queue_entries WHERE session_id='draft-2'"),'queued');
  }finally{release.resolve();await p.cleanup();}
});

test('an enqueue notification during the final empty claim is retained for another drain',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{let held=false,starts=0;
    const custom=proxy(p.port,{execute:async(request)=>{const result=await p.port.execute<CoreCommandName>(request);if(!held&&request.command.name==='queue.claim'&&result.state==='committed'&&result.value===null){held=true;entered.resolve();await release.promise;}return result;}});
    const service=p.make({start:async(_claim,context)=>{await context.dispatch(()=>{starts++;});}},custom),run=service.drain(key);await entered.promise;
    await p.enqueue();const notified=service.drain(key);assert.equal(notified,run);release.resolve();await run;assert.equal(starts,1);
  }finally{release.resolve();await p.cleanup();}
});

test('an async exclusive check released after close cannot create a claim',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{await p.enqueue();const service=p.make({assertExclusiveWriter:async()=>{entered.resolve();await release.promise;}}),run=service.drain(key);await entered.promise;
    const closing=service.close();release.resolve();await assert.rejects(run,{code:'STORAGE_UNAVAILABLE'});await closing;assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
  }finally{release.resolve();await p.cleanup();}
});

test('a stale positive claim receipt is never sufficient after the requester is disabled',async()=>{
  const p=await prepared();try{await p.enqueue();let lost=false,starts=0;
    const custom=proxy(p.port,{execute:async(request)=>{const result=await p.port.execute<CoreCommandName>(request);if(!lost&&request.command.name==='queue.claim'){lost=true;return{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'};}return result;}});
    const service=p.make({start:async(_claim,context)=>{await context.dispatch(()=>{starts++;});}},custom);await service.drain(key);p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");await service.drain(key);
    assert.equal(starts,0);assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
  }finally{await p.cleanup();}
});
