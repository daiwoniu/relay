import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { StoredCreditReset } from './stored-credit-reset.js';
import { hashSessionToken } from '../auth/session.js';
const actor={kind:'user' as const,userId:'admin',authSessionHash:hashSessionToken('synthetic-reset-admin')};
const identity='chatgpt:a@example.test';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function prepared(){const f=fixture();f.mutate(`DELETE FROM engine_resource_leases;UPDATE sessions SET status='idle';INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${actor.authSessionHash}','admin',${Date.now()+600000})`);const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});return{f,port};}

test('unknown reset response persists dispatch and refuses both same-key and new-key external retries after replacement',async()=>{
  const{f,port}=await prepared();let calls=0;const options={port,storeId:'store',generation:1,assertExclusiveWriter:async()=>{},loadIdentity:async()=>identity,invalidateOfficial:()=>{},
    consume:async(_input:any,context:any)=>{assert.equal(await context.mayDispatch(),true);calls++;throw Error('reply lost');}};
  let service=new StoredCreditReset(options);const request={idempotencyKey:randomUUID()};
  try{
    await assert.rejects(()=>service.run(actor,request),/STORAGE_UNAVAILABLE/);assert.equal(calls,1);await service.close();service=new StoredCreditReset(options);
    await assert.rejects(()=>service.run(actor,request),/STORAGE_UNAVAILABLE/);
    await assert.rejects(()=>service.run(actor,{idempotencyKey:randomUUID()}),/CONFLICT/);assert.equal(calls,1);
    assert.equal((await port.readCreditResetJob({principal:actor,jobId:request.idempotencyKey}))?.phase,'dispatched');
    assert.equal((await port.readMaintenanceState({principal:{kind:'system',purpose:'maintenance'}})).byEngine.codex,1);
  }finally{await service.close();await port.close();f.cleanup();}
});

test('lost claim reply is resolved once, close waits physical completion and proven outcome survives role revocation',async()=>{
  const{f,port}=await prepared();let calls=0,entered=false,finish!:(value:'reset')=>void,invalidated=0;
  const wrapped=new Proxy(port,{get:(target,key)=>key==='execute'?async(request:any)=>{
    const result=await target.execute(request);return request.command.name==='creditReset.claim'&&result.state==='committed'?{state:'unknown',operationId:request.operationId}:result;
  }:typeof(target as any)[key]==='function'?(target as any)[key].bind(target):(target as any)[key]}) as CoreStoragePort;
  const service=new StoredCreditReset({port:wrapped,storeId:'store',generation:1,assertExclusiveWriter:async()=>{},loadIdentity:async()=>identity,invalidateOfficial:()=>{invalidated++;},
    consume:async(input,context)=>{assert.equal(input.creditId,'credit');assert.equal(await context.mayDispatch(),true);calls++;entered=true;return new Promise<'reset'>(resolve=>{finish=resolve;});}});
  const request={idempotencyKey:randomUUID(),creditId:'credit'};
  try{
    const first=service.run(actor,request),same=service.run(actor,request);assert.equal(first,same);const rejected=assert.rejects(()=>first,/FORBIDDEN/);
    for(let n=0;n<200&&!entered;n++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(entered,true);
    let closed=false;const close=service.close().then(()=>{closed=true;});await tick();assert.equal(closed,false);
    f.mutate("UPDATE users SET role='member' WHERE id='admin'");finish('reset');await rejected;await close;
    assert.equal(calls,1);assert.equal(invalidated,1);assert.equal(f.scalar('SELECT outcome FROM _relay_credit_resets'),'reset');
    f.mutate("UPDATE users SET role='admin' WHERE id='admin'");
    const replay=new StoredCreditReset({port,storeId:'store',generation:1,assertExclusiveWriter:async()=>{},loadIdentity:async()=>{throw Error('completed retry must not query provider');},consume:async()=>{throw Error('must not send again');},invalidateOfficial:()=>{}});
    assert.equal(await replay.run(actor,request),'reset');await replay.close();
  }finally{await service.close();await port.close();f.cleanup();}
});

test('identity change before claim rejects the prepared job without consuming credit',async()=>{
  const{f,port}=await prepared();let reads=0,calls=0;
  const service=new StoredCreditReset({port,storeId:'store',generation:1,assertExclusiveWriter:async()=>{},loadIdentity:async()=>++reads===1?identity:'chatgpt:changed@example.test',
    consume:async()=>{calls++;return'noCredit';},invalidateOfficial:()=>{}});
  try{
    await assert.rejects(()=>service.run(actor,{idempotencyKey:randomUUID()}),/CONFLICT/);assert.equal(calls,0);
    assert.equal(f.scalar('SELECT phase FROM _relay_credit_resets'),'rejected');
  }finally{await service.close();await port.close();f.cleanup();}
});
