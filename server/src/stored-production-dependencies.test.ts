import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from './storage/worker-client.js';
import { createStoredProductionEngines } from './stored-production-engines.js';
import { createStoredProductionDependencies } from './stored-production-dependencies.js';

test('real production dependencies prepare without provider work, history edits or news activation and clean up their listeners',async()=>{
  process.env.RELAY_STORAGE_DRIVER='native';
  process.env.RELAY_ACCESS_TOKEN='synthetic-production-preparation';
  const{createStoredApplication}=await import('./stored-application.js');
  const f=fixture(),initialListeners=process.listenerCount('message');
  const seed=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});await seed.close();
  let configured:Awaited<ReturnType<typeof createStoredProductionDependencies>>|undefined,catalogCalls=0;
  const engines=createStoredProductionEngines({root:f.directory,withCodexReady:work=>{
    if(!configured)throw Error('production lifecycle not bound');return configured.withCodexReady(work);
  },codexModelReader:async()=>{catalogCalls++;throw Error('provider must remain idle');}});
  const newsRoot=path.join(f.directory,'news');
  let application:Awaited<ReturnType<typeof createStoredApplication>>|undefined;
  try{
    application=await createStoredApplication({storage:{filename:f.filename,storeId:'store',generation:2},
      runtime:{registry:engines.registry,collectFileChanges:async()=>{throw Error('terminal collection before activation');},attachmentAvailability:()=>false,
        resolveResource:()=>null,diagnostic:()=>{throw Error('recovery before activation');}},
      dependencies:async scope=>{
        configured=await createStoredProductionDependencies(scope,{engines,codexHome:path.join(f.directory,'synthetic-codex'),personalWorkspacePath:f.directory,
          themeRoot:path.join(f.directory,'theme'),repairSourceRoot:f.directory,chinaDayCacheRoot:path.join(f.directory,'china-day'),newsRoot,
          publicShares:{getClientId:()=> 'synthetic-client'},attachmentAvailability:()=>false,diagnostic:()=>{throw Error('unexpected startup work');}});
        return configured.dependencies;
      }});
    assert.equal(application.host.status,'prepared');assert.equal((await application.app.request('/api/health')).status,503);
    assert.equal(catalogCalls,0);assert.equal(f.scalar('SELECT COUNT(*) FROM messages'),2);assert.equal(f.scalar('SELECT COUNT(*) FROM engine_resource_leases'),1);
    assert.equal(f.scalar("SELECT COUNT(*) FROM _relay_maintenance_fence"),0);
    await assert.rejects(()=>fs.stat(newsRoot),(error:any)=>error.code==='ENOENT');
  }finally{
    await application?.close();engines.close();assert.equal(process.listenerCount('message'),initialListeners);f.cleanup();
  }
});
