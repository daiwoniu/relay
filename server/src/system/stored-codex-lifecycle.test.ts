import test from 'node:test';
import assert from 'node:assert/strict';
import { StoredCodexLifecycle } from './stored-codex-lifecycle.js';
import type { CoreStoragePort } from '../storage/contracts.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}

test('Native Codex lifecycle coalesces async polls and never lets stale zero counts override provider holds',async()=>{
  const first=deferred<any>(),messages:string[]=[];let calls=0,active=0,fail=false,owner=true;
  const port={readMaintenanceState:async()=>{calls++;if(calls===1)return first.promise;if(fail)throw Error('unavailable');return{byEngine:{codex:active}};}} as unknown as CoreStoragePort;
  const service=new StoredCodexLifecycle({port,send:message=>messages.push(message.type),ensureReady:async()=>{},assertExclusiveWriter:async()=>{if(!owner)throw Error('lost owner');},intervalMs:5});
  const start=service.start();await service.ensureReady();await service.ensureReady();first.resolve({byEngine:{codex:0}});await start;
  assert.deepEqual(messages,['activity_started']);service.releaseReady();await tick();assert.deepEqual(messages,['activity_started']);
  active=1;service.releaseReady();await tick();assert.deepEqual(messages,['activity_started']);
  active=0;fail=true;await new Promise(resolve=>setTimeout(resolve,15));assert.deepEqual(messages,['activity_started']);
  fail=false;await new Promise(resolve=>setTimeout(resolve,15));assert.deepEqual(messages,['activity_started','idle']);
  owner=false;await assert.rejects(()=>service.ensureReady(),/lost owner/);await service.close();
  assert.deepEqual(messages,['activity_started','idle']);await assert.rejects(()=>service.ensureReady(),/NOT_SUBMITTED/);
});

test('Native lifecycle close waits actual provider holds and emits no late idle signal',async()=>{
  const messages:string[]=[];const service=new StoredCodexLifecycle({port:{readMaintenanceState:async()=>({byEngine:{codex:0}})} as unknown as CoreStoragePort,
    send:message=>messages.push(message.type),ensureReady:async()=>{},assertExclusiveWriter:async()=>{}});
  await service.start();await service.ensureReady();let closed=false;const close=service.close().then(()=>{closed=true;});await tick();assert.equal(closed,false);
  service.releaseReady();await close;assert.deepEqual(messages,['idle','activity_started']);
});
