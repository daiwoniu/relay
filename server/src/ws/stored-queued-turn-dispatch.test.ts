import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,markRead } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StoredProviderTurnScheduler } from '../engine/concurrency/stored-scheduler.js';
import { StoredQueuedTurnDispatcher,type StoredQueuedTurnPorts } from './stored-queued-turn-dispatch.js';
import type { QueueClaim } from '../storage/contracts.js';

const key='codex:default',principal={kind:'system',purpose:'scheduler'} as const;
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};};
async function setup(){
  const f=fixture();f.mutate('DELETE FROM engine_resource_leases');
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true,defaultConcurrency:{[key]:1}});
  const enqueued=await port.execute({...markRead(),operationId:'enqueue',command:{name:'turn.enqueue',input:{sessionId:'draft',attemptId:'attempt',messageId:'message',
    engineId:'codex',resourceKey:key,content:'committed user content',metadata:null,expectedPreferencesRevision:0,origin:{kind:'direct'},
    draft:{projectId:'project',title:'test',titleManuallySet:false}}}});assert.equal(enqueued.state,'committed');
  let scheduler:StoredProviderTurnScheduler|undefined;
  return{f,port,make:(prepare:StoredQueuedTurnPorts['prepare'],failed:ConstructorParameters<typeof StoredProviderTurnScheduler>[1]['failed']=async()=>{})=>{
    const dispatcher=new StoredQueuedTurnDispatcher(port,{prepare});scheduler=new StoredProviderTurnScheduler(port,{storeId:'store',generation:1,
      assertExclusiveWriter:async()=>{},onFailure:()=>{},start:(claim,context)=>dispatcher.start(claim,context),failed});return scheduler;},
    cleanup:async()=>{await scheduler?.close();await port.close();f.cleanup();}};
}

test('native dispatcher loads the committed message and immutable private preparation snapshot',async()=>{
  const p=await setup();try{let invoked=0,released:boolean|undefined;
    await p.make(async(claim,payload)=>{assert.equal(claim.userMessageId,'message');assert.equal(payload.message.content,'committed user content');assert.equal(payload.session.projectPath,'D:/synthetic');
      assert.equal(Object.isFrozen(payload),true);assert.equal(Object.isFrozen(payload.message),true);assert.equal(Object.isFrozen(payload.session),true);
      return{invoke:async()=>{invoked++;},release:async(state)=>{released=state.invoked;}};}).drain(key);
    assert.equal(invoked,1);assert.equal(released,true);assert.equal(p.f.scalar("SELECT count(*) FROM engine_capacity_events WHERE event_type='start_claimed'"),1);
  }finally{await p.cleanup();}
});

test('message, project path, preferences and engine state changes during preparation invalidate the old payload',async()=>{
  for(const sql of ["UPDATE messages SET content='newer' WHERE id='message'","UPDATE projects SET path='D:/changed' WHERE id='project'",
    "UPDATE sessions SET selected_model_id='changed',engine_preferences_revision=1 WHERE id='draft'","UPDATE sessions SET engine_metadata='{}' WHERE id='draft'",
    "UPDATE sessions SET engine='codebuddy' WHERE id='draft'"]){
    const p=await setup();try{let invoked=0,released:boolean|undefined,effect:boolean|undefined;
      await p.make(async()=>{p.f.mutate(sql);return{invoke:async()=>{invoked++;},release:async(state)=>{released=state.invoked;}};},async(_claim,_error,state)=>{effect=state.effectStarted;}).drain(key);
      assert.equal(invoked,0);assert.equal(released,false);assert.equal(effect,false);assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'),1);
    }finally{await p.cleanup();}
  }
});

test('unvalidated attachments and malformed message metadata fail before engine preparation',async()=>{
  for(const value of ['{broken','[]','null','{"attachments":null}','{"attachments":[{"path":"D:/unverified"}]}']){
    const p=await setup();try{p.f.mutate(`UPDATE messages SET metadata='${value}' WHERE id='message'`);let prepared=0;const errors:string[]=[];
      await p.make(async()=>{prepared++;throw Error('must not prepare');},async(_claim,error)=>{errors.push((error as {code:string}).code);}).drain(key);
      assert.equal(prepared,0);assert.equal(errors.length,1);assert.ok(['NOT_SUPPORTED','STORAGE_UNAVAILABLE'].includes(errors[0]));
    }finally{await p.cleanup();}
  }
});

test('an absent, mismatched or oversized persisted user message cannot be replaced by a client payload',async()=>{
  for(const sql of ["UPDATE messages SET role='assistant' WHERE id='message'","UPDATE messages SET turn_id='another' WHERE id='message'",
    "UPDATE messages SET content=CAST(zeroblob(4194305) AS TEXT) WHERE id='message'"]){
    const p=await setup();try{p.f.mutate(sql);let prepares=0;
      await p.make(async()=>{prepares++;throw Error('unexpected');}).drain(key);assert.equal(prepares,0);
    }finally{await p.cleanup();}
  }
});

test('close during async preparation drains the preparer and releases only unused preparation ownership',async()=>{
  const p=await setup(),entered=gate(),release=gate();try{let invoked=0,released:boolean|undefined;
    const scheduler=p.make(async()=>{entered.resolve();await release.promise;return{invoke:async()=>{invoked++;},release:async(state)=>{released=state.invoked;}};}),run=scheduler.drain(key);await entered.promise;
    let closed=false;const closing=scheduler.close().then(()=>{closed=true;});await Promise.resolve();assert.equal(closed,false);release.resolve();await run;await closing;
    assert.equal(invoked,0);assert.equal(released,false);
  }finally{release.resolve();await p.cleanup();}
});

test('an ambiguous actual engine invocation retains claimed state and transfers live runtime responsibility',async()=>{
  const p=await setup();try{let released:boolean|undefined,effect:boolean|undefined;
    await p.make(async()=>({invoke:async()=>{throw Error('lost engine reply');},release:async(state)=>{released=state.invoked;}}),async(_claim,_error,state)=>{effect=state.effectStarted;}).drain(key);
    assert.equal(released,true);assert.equal(effect,true);assert.equal(p.f.scalar("SELECT state FROM engine_queue_entries WHERE session_id='draft'"),'claimed');
  }finally{await p.cleanup();}
});

test('source guards bind message identity, original content and every selected preference',async()=>{
  const p=await setup();try{let captured:QueueClaim|undefined,digest='';await p.make(async(claim,payload)=>{captured=claim;digest=payload.sourceDigest;return{invoke:async()=>{},release:async()=>{}};}).drain(key);
    assert.equal(await p.port.checkQueueDispatch({principal,claim:captured!,sourceDigest:digest}),true);
    assert.equal(await p.port.checkQueueDispatch({principal,claim:captured!,sourceDigest:'0'.repeat(64)}),false);
    p.f.mutate("UPDATE sessions SET selected_service_tier='priority' WHERE id='draft'");assert.equal(await p.port.checkQueueDispatch({principal,claim:captured!,sourceDigest:digest}),false);
    await assert.rejects(p.port.readClaimedTurn({principal:{kind:'system',purpose:'maintenance'},claim:captured!}),{code:'INVALID_ARGUMENT'});
  }finally{await p.cleanup();}
});
