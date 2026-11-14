import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoredHostContext } from './stored-host-context.js';
import type { StoredRuntimeEvents } from '../engine/stored-runtime-events.js';
import type { StoredClaimedTurn } from '../storage/contracts.js';
import { RELAY_HOST_CONTEXT_VERSION } from '../engine/host-context.js';

function harness(metadata: string|null=null, compactionCount=0) {
  const writes: unknown[]=[];let terminal=false;
  let response: unknown={state:'handled',value:{value:{updated:true}}};
  const binding={session:{engineSessionId:'external',engineMetadata:metadata,contextCompactionCount:compactionCount} as StoredClaimedTurn['session'],
    events:{storage:{isTerminalCommitted:()=>terminal,setHostContext:(input:unknown)=>{writes.push(input);return Promise.resolve(response);}}} as unknown as StoredRuntimeEvents};
  let current:typeof binding|null=binding;
  const proxy=createStoredHostContext(()=>current,()=>true);
  return {proxy,writes,replace:()=>{current={...binding};},terminal:()=>{terminal=true;},result:(value:unknown)=>{response=value;}};
}
const marker=(id='external',count=0,version=RELAY_HOST_CONTEXT_VERSION)=>JSON.stringify({other:'preserved',relayHostContext:{version,externalSessionId:id,compactionCount:count}});

test('Native send scopes only trust markers matching version, session and compaction count',()=>{
  assert.equal(harness(marker()).proxy.capture!().delivered,true);
  for(const metadata of [null,'broken','[]',marker('other'),marker('external',1),marker('external',0,99)])
    assert.equal(harness(metadata).proxy.capture!().delivered,false);
});
test('captured callbacks cannot acquire a later binding or write after terminal',async()=>{
  for(const retire of ['replace','terminal'] as const){
    const h=harness();const captured=h.proxy.capture!();h[retire]();
    await assert.rejects(async()=>captured.onDelivered('external'),{code:'CONFLICT'});
    assert.deepEqual(h.writes,[]);
  }
});
test('delivery requires confirmed Native update; stale and unknown never become success',async()=>{
  for(const result of [{state:'stale'},{state:'handled',value:{value:{updated:false}}}]){
    const h=harness();h.result(result);
    await assert.rejects(async()=>h.proxy.capture!().onDelivered('external'),{code:'CONFLICT'});
    assert.equal(h.proxy.capture!().delivered,false);
  }
});
test('marker work is enqueued synchronously and missing invalidation is idempotent',async()=>{
  const h=harness();const scope=h.proxy.capture!();
  const pending=scope.onDelivered('external');
  assert.deepEqual(h.writes,[{externalSessionId:'external',compactionCount:0,delivered:true}]);await pending;
  h.result({state:'handled',value:{value:{updated:false}}});await scope.onInvalidated!('external');
  assert.equal(h.writes.length,2);
});
