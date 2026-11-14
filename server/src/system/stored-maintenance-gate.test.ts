import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { StoredMaintenanceGate } from './stored-maintenance-gate.js';

test('Native admission gate resolves a lost acquire reply by exact receipt and close preserves its durable fence',async()=>{
  const f=fixture();let port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const wrapped=new Proxy(port,{get:(target,key)=>key==='execute'?async(request:any)=>{const result=await target.execute(request);return result.state==='committed'?{state:'unknown',operationId:request.operationId}:result;}:typeof(target as any)[key]==='function'?(target as any)[key].bind(target):(target as any)[key]}) as CoreStoragePort;
  const gate=new StoredMaintenanceGate({port:wrapped,storeId:'store',generation:1,assertExclusiveWriter:async()=>{}});
  try{
    assert.equal((await gate.release('cutover')).state,'rejected','release cannot create a negative receipt before acquisition');
    const acquired=await gate.acquire({fenceId:'cutover',engineId:null});assert.equal(acquired.state,'committed');
    assert.deepEqual((await gate.read()).fence,{fenceId:'cutover',engineId:null});await gate.close();await port.close();
    port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:2});
    const reopened=new StoredMaintenanceGate({port,storeId:'store',generation:2,assertExclusiveWriter:async()=>{}});
    assert.deepEqual((await reopened.read()).fence,{fenceId:'cutover',engineId:null});
    assert.equal((await reopened.acquire({fenceId:'other',engineId:'codex'})).state,'rejected');
    assert.equal((await reopened.release('cutover')).state,'committed');assert.equal((await reopened.read()).fence,null);
    await reopened.close();
  }finally{await gate.close();await port.close();f.cleanup();}
});
