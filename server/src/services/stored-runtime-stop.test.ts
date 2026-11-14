import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,markRead } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { createSessionRuntimeState } from '../engine/runtime.js';
import type { EngineConnection } from '../engine/adapter.js';
import { StoredRuntimeEvents } from '../engine/stored-runtime-events.js';
import { StoredRuntimeStop,type StoredStopBinding,type StopDiagnostic } from './stored-runtime-stop.js';
import type { CoreStoragePort,StoragePrincipal,StorageCommandEnvelope,CommandResult,CoreCommandName } from '../storage/contracts.js';
type Options=ConstructorParameters<typeof StoredRuntimeStop>[1];
const owner=markRead().principal as Extract<StoragePrincipal,{kind:'user'}>,admin=markRead('read','admin').principal as typeof owner;
const input={sessionId:'session',expectedAttemptId:'attempt'};
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};};
function proxy(port:CoreStoragePort,execute:(request:StorageCommandEnvelope)=>Promise<CommandResult<CoreCommandName>>):CoreStoragePort{
  return new Proxy(port,{get(target,key){if(key==='execute')return execute;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
}
async function setup(cancel:()=>Promise<void>=async()=>{}){
  const f=fixture(),port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true}),services:StoredRuntimeStop[]=[];
  const runtime=createSessionRuntimeState({sessionId:'session',projectId:'project',engine:'codex'});
  Object.assign(runtime,{attemptId:'attempt',engineConnectionId:'connection',leaseToken:'lease',resourceKey:'codex:default',isRunning:true,
    engineConnection:{cancel} as EngineConnection});
  let binding:StoredStopBinding|undefined={runtime,version:1,events:undefined!};
  const events=new StoredRuntimeEvents(runtime,port,{storeId:'store',generation:1,runtimeVersion:1,isOwned:r=>binding?.runtime===r,onFailure:()=>{}});binding.events=events;
  const onStopped:Options['onStopped']=async(_binding,context)=>{
    await context.persistTerminal({decision:{id:randomUUID(),sessionId:'session',attemptId:'attempt',engineId:'codex',outcome:'stopped',reasonCode:'USER_STOPPED',
      factId:context.fact.id,decidedAt:Date.now(),projectedAt:null},message:{id:randomUUID(),turnId:'attempt',content:'',items:null,metadata:null,durationMs:1}});
  };
  return{f,port,runtime,events,get binding(){return binding;},replace:()=>{binding=undefined;},make:(options:Partial<Options>={},custom:CoreStoragePort=port)=>{
    const service=new StoredRuntimeStop(custom,{storeId:'store',generation:1,assertExclusiveWriter:async()=>{},getBinding:()=>binding,onStopped,...options});services.push(service);return service;},
    cleanup:async()=>{await Promise.all(services.map(s=>s.close()));await events.close();await port.close();f.cleanup();}};
}

test('explicit stop commits intent before one actual cancel and persists evidence/terminal before confirmation',async()=>{
  let cancels=0;const p=await setup(async()=>{cancels++;assert.equal(p.f.scalar('SELECT status FROM sessions'),'stopping');});try{
    const result=await p.make().request(admin,input,'stop');assert.deepEqual(result,{state:'requested',confirmed:true});assert.equal(cancels,1);
    assert.equal(p.f.scalar('SELECT status FROM sessions'),'stopped');assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='started'"),1);assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE result='succeeded'"),1);
  }finally{await p.cleanup();}
});

test('stop diagnostics distinguish local fencing, provider failure and persisted confirmation without raw errors',async()=>{
  for(const mode of ['binding','authority','provider','rpc','local_type','terminal','success'] as const){
    const events:StopDiagnostic[]=[];let cancels=0;
    const p=await setup(async()=>{cancels++;
      if(mode==='provider')throw Object.assign(Error('secret provider URL and prompt'),{code:'ECONNRESET'});
      if(mode==='rpc')throw Object.assign(Error('secret remote RPC details'),{rpcCode:-32602});
      if(mode==='local_type')throw TypeError('secret internal details');
    });
    try{
      if(mode==='binding')p.replace();
      const options:Partial<Options>={onDiagnostic:event=>events.push(event),
        ...(mode==='authority'?{onRequested:async()=>{p.runtime.attemptId='new-attempt';}}:{}),
        ...(mode==='terminal'?{onStopped:async()=>{}}:{})};
      const result=await p.make(options).request(owner,input,'private-operation-id');
      const last=events.at(-1)!;
      assert.equal(result.state,mode==='success'?'requested':'unknown');
      assert.equal(last.stage,mode==='authority'?'dispatch':mode==='success'?'terminal':['rpc','local_type'].includes(mode)?'provider':mode);
      assert.equal(last.event,mode==='success'?'confirmed':'failed');
      if(mode==='provider')assert.equal(last.code,'ECONNRESET');
      if(mode==='rpc')assert.equal(last.code,'RPC_-32602');
      if(mode==='local_type')assert.equal(last.code,'LOCAL_TYPE_ERROR');
      assert.equal(cancels,['binding','authority'].includes(mode)?0:1);
      assert.match(last.trace,/^[a-f0-9]{16}$/);
      assert.ok(events.every(event=>event.trace===last.trace&&event.elapsedMs>=0));
      assert.doesNotMatch(JSON.stringify(events),/private-operation-id|secret provider|auth-owner/);
      if(mode!=='success')assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
    }finally{await p.cleanup();}
  }
});

test('a diagnostic callback failure cannot change a confirmed stop',async()=>{
  const p=await setup();try{
    assert.deepEqual(await p.make({onDiagnostic:()=>{throw Error('log unavailable');}}).request(owner,input,'stop'),{state:'requested',confirmed:true});
  }finally{await p.cleanup();}
});

test('identical in-flight stops coalesce and replaying a finished operation never cancels again',async()=>{
  const entered=gate(),release=gate();let cancels=0;const p=await setup(async()=>{cancels++;entered.resolve();await release.promise;});try{
    const service=p.make(),first=service.request(owner,input,'stop');await entered.promise;assert.equal(service.request(owner,input,'stop'),first);
    assert.deepEqual(await service.request(owner,{...input,expectedAttemptId:'other'},'stop'),{state:'rejected',code:'CONFLICT'});
    release.resolve();assert.deepEqual(await first,{state:'requested',confirmed:true});assert.deepEqual(await service.request(owner,input,'stop'),{state:'unknown'});assert.equal(cancels,1);
  }finally{release.resolve();await p.cleanup();}
});

test('a lost Native stop reply preserves stopping and never dispatches by replaying a historical receipt',async()=>{
  let cancels=0;const p=await setup(async()=>{cancels++;});try{const custom=proxy(p.port,async(request)=>{const result=await p.port.execute<CoreCommandName>(request);
    if(request.command.name==='turn.requestStop'&&result.state==='committed'&&!result.replayed)return{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'};return result;});
    const service=p.make({},custom);assert.deepEqual(await service.request(owner,input,'stop'),{state:'unknown'});assert.deepEqual(await p.make().request(owner,input,'stop'),{state:'unknown'});
    assert.equal(cancels,0);assert.equal(p.f.scalar('SELECT status FROM sessions'),'stopping');assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
  }finally{await p.cleanup();}
});

test('a newer attempt, replaced registry, expiry and demotion during async notification cannot receive the cancel',async()=>{
  for(const change of ['attempt','registry','expired','demoted']){let cancels=0;const p=await setup(async()=>{cancels++;});try{
    const service=p.make({onRequested:async()=>{if(change==='attempt')p.runtime.attemptId='new';else if(change==='registry')p.replace();else if(change==='expired')p.f.mutate("UPDATE auth_sessions SET expires_at=1 WHERE user_id='admin'");else p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");}});
    assert.deepEqual(await service.request(admin,input,'stop'),{state:'unknown'});assert.equal(cancels,0);assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
  }finally{await p.cleanup();}}
});

test('cancel rejection does not fabricate stopped evidence, clear the lease or retry an ambiguous RPC',async()=>{
  let cancels=0;const p=await setup(async()=>{cancels++;throw Error('ambiguous cancellation');});try{const service=p.make();assert.deepEqual(await service.request(owner,input,'stop'),{state:'unknown'});
    assert.equal(p.f.scalar('SELECT count(*) FROM engine_turn_facts'),0);assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);assert.equal(p.runtime.isStopping,true);
    assert.deepEqual(await service.request(owner,input,'second'),{state:'requested',confirmed:false});assert.equal(cancels,1);
  }finally{await p.cleanup();}
});

test('closing before an exclusive check finishes cannot dispatch a stop intent',async()=>{
  const entered=gate(),release=gate(),p=await setup();try{const service=p.make({assertExclusiveWriter:async()=>{entered.resolve();await release.promise;}}),run=service.request(owner,input,'stop');await entered.promise;
    const closing=service.close();release.resolve();assert.equal((await run).state,'rejected');await closing;assert.equal(p.f.scalar("SELECT count(*) FROM _relay_storage_operations WHERE command_name='turn.requestStop'"),0);
  }finally{release.resolve();await p.cleanup();}
});

test('shutdown drains an actual cancel and its terminal persistence before the Native port is closed',async()=>{
  const entered=gate(),release=gate(),p=await setup(async()=>{entered.resolve();await release.promise;});try{const service=p.make(),run=service.request(owner,input,'stop');await entered.promise;
    let closed=false;const closing=service.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);release.resolve();assert.deepEqual(await run,{state:'requested',confirmed:true});await closing;
    assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),0);
  }finally{release.resolve();await p.cleanup();}
});

test('an old cancel completion cannot persist terminal evidence onto a replacement runtime',async()=>{
  const entered=gate(),release=gate(),p=await setup(async()=>{entered.resolve();await release.promise;});try{const service=p.make(),run=service.request(owner,input,'stop');await entered.promise;p.replace();release.resolve();assert.deepEqual(await run,{state:'requested',confirmed:false});
    assert.equal(p.f.scalar('SELECT count(*) FROM engine_turn_facts'),0);assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
  }finally{release.resolve();await p.cleanup();}
});

test('a local stopped callback must actually persist the stopped terminal before success is exposed',async()=>{
  const p=await setup();try{assert.deepEqual(await p.make({onStopped:async()=>{}}).request(owner,input,'stop'),{state:'unknown'});
    assert.equal(p.f.scalar('SELECT count(*) FROM engine_turn_facts'),1);assert.equal(p.f.scalar('SELECT count(*) FROM engine_terminal_decisions'),0);
  }finally{await p.cleanup();}
});
