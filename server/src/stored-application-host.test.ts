import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture } from './storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from './storage/worker-client.js';
import { StoreOwner } from './storage/store-owner.js';
import { EngineRegistry } from './engine/registry.js';
import type { StoredApplicationHostOptions } from './stored-application-host.js';

const graph={registry:new EngineRegistry([]),collectFileChanges:async()=>({}),attachmentAvailability:()=>false,resolveResource:()=>null,diagnostic:()=>{}};
function http(){
  const unused=new Proxy({},{get:()=>()=>{throw Error('unrequested external service');}});
  const services=Object.fromEntries(['uploads','uploadReads','draftCleanup','archivedCleanup','downloads','themeAssets','unarchive','fork','shares','repair','filesystem'].map(key=>[key,{service:unused}]));
  Object.assign(services,{chinaDay:{cache:unused},news:{service:unused}});
  return {...services,auth:{workspacePath:'D:/synthetic-host'},reads:{refreshSessionArchiveState:async()=>{}},writes:{softDelete:unused},publicShares:{getClientId:()=> 'synthetic-host'},trash:{service:unused,purge:unused},workspace:{service:unused,snapshots:unused},accountResources:{snapshots:unused,localUsage:unused},concurrency:{resources:[],changed:async()=>{}},system:{version:unused,engines:unused,resources:unused,models:unused,recovery:unused,maintenance:unused}} as unknown as Awaited<ReturnType<StoredApplicationHostOptions['build']>>['http'];
}
async function prepared(){const f=fixture();f.mutate("DELETE FROM engine_resource_leases;UPDATE sessions SET active_attempt_id=NULL,status='idle'");const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});await port.close();return f;}
test('Native host owns before build, activates explicitly, and retains ownership until all physical closers settle',async()=>{
  process.env.RELAY_ACCESS_TOKEN='synthetic-native-host';const {StoredApplicationHost}=await import('./stored-application-host.js');
  const f=await prepared(),events:string[]=[];let failClose=true;
  const host=await StoredApplicationHost.open({storage:{filename:f.filename,storeId:'store',generation:2},graph,build:async scope=>{
    await assert.rejects(StoreOwner.acquire(f.filename),/CONFLICT/);
    scope.own('physical-worker',async()=>{events.push('close');if(failClose)throw Error('physical closer unconfirmed');});
    return {http:http(),recover:async()=>{events.push('recover');},resume:async()=>{events.push('resume');}};
  }});
  try{
    assert.equal(host.status,'prepared');assert.deepEqual(events,[]);assert.equal((await host.app.request('/api/health')).status,503);
    assert.equal((await host.activate()).restored,0);
    assert.equal(host.status,'ready');assert.deepEqual(events,['recover','resume']);assert.equal((await host.app.request('/api/health')).status,200);
    await assert.rejects(host.close(),/physical closer unconfirmed/);assert.equal(host.status,'closing');
    await assert.rejects(StoreOwner.acquire(f.filename),/CONFLICT/);
    assert.ok(await fs.stat(f.filename+'.relay-owner'));
    failClose=false;await host.close();assert.equal(host.status,'closed');
    const next=await StoreOwner.acquire(f.filename);await next.release();
  }finally{failClose=false;await host.close();f.cleanup();}
});

test('Native host drains registered partial construction and releases ownership on startup failure',async()=>{
  process.env.RELAY_ACCESS_TOKEN='synthetic-native-host';const {StoredApplicationHost}=await import('./stored-application-host.js');
  const f=await prepared();let closed=false;
  try{
    await assert.rejects(StoredApplicationHost.open({storage:{filename:f.filename,storeId:'store',generation:2},graph,build:async scope=>{
      scope.own('allocated',async()=>{closed=true;});throw Error('synthetic build failure');
    }}),/synthetic build failure/);
    assert.equal(closed,true);const next=await StoreOwner.acquire(f.filename);await next.release();
  }finally{f.cleanup();}
});

test('Native host retains its DB owner while a process pool remains physically unclosed after runtime suspension',async()=>{
  process.env.RELAY_ACCESS_TOKEN='synthetic-native-host';const{StoredApplicationHost}=await import('./stored-application-host.js');
  const f=await prepared();let fail=true;
  const host=await StoredApplicationHost.open({storage:{filename:f.filename,storeId:'store',generation:2},graph,
    afterRuntimeSuspend:async()=>{if(fail)throw Error('process pool close unconfirmed');},build:async()=>({http:http(),recover:async()=>{},resume:async()=>{}})});
  try{
    await assert.rejects(host.close(),/process pool close unconfirmed/);
    await assert.rejects(StoreOwner.acquire(f.filename),/CONFLICT/);
    fail=false;await host.close();const next=await StoreOwner.acquire(f.filename);await next.release();
  }finally{fail=false;await host.close();f.cleanup();}
});
