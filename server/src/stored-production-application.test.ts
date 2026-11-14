import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from './storage/worker-client.js';
import os from 'node:os';
import { initializeLocalStorage } from './storage/local-storage-initializer.js';
import { StoreOwner } from './storage/store-owner.js';

test('complete production application prepares with real file workers and closes without starting providers or news', async () => {
  process.env.RELAY_ACCESS_TOKEN = 'synthetic-production-application';
  const { prepareStoredProductionApplication } = await import('./stored-production-application.js');
  const f = fixture(), initialListeners = process.listenerCount('message');
  let app: Awaited<ReturnType<typeof prepareStoredProductionApplication>> | undefined;
  try {
    const seed = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true }); await seed.close();
    app = await prepareStoredProductionApplication({ root: f.directory, storage: { filename: f.filename, storeId: 'store', generation: 2 },
      codexHome: path.join(f.directory, 'codex'), personalWorkspacePath: f.directory, themeRoot: path.join(f.directory, 'theme'),
      repairSourceRoot: f.directory, chinaDayCacheRoot: path.join(f.directory, 'cache'), newsRoot: path.join(f.directory, 'news'),
      publicShares: { getClientId: () => 'synthetic-client' }, diagnostic: () => { throw Error('unexpected preparation work'); } });
    assert.equal(app.host.status, 'prepared');
    assert.equal((await app.app.request('/api/health')).status, 503);
    assert.equal(f.scalar('SELECT COUNT(*) FROM messages'), 2);
    await assert.rejects(fs.stat(path.join(f.directory, 'news')), { code: 'ENOENT' });
  } finally {
    await app?.close(); assert.equal(process.listenerCount('message'), initialListeners); f.cleanup();
  }
});

test('fresh startup hands the existing owner to the production application without a lock gap',async()=>{
  process.env.RELAY_ACCESS_TOKEN='synthetic-production-application';
  const {prepareStoredProductionApplication}=await import('./stored-production-application.js');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-local-production-')),filename=path.join(root,'relay.db');
  let app:Awaited<ReturnType<typeof prepareStoredProductionApplication>>|undefined;
  try{
    const initial=await initializeLocalStorage(filename,path.join(root,'workspace'));
    app=await prepareStoredProductionApplication({root,storage:{filename:initial.owner.filename,storeId:initial.storeId,generation:1},storageOwner:initial.owner,
      codexHome:path.join(root,'codex'),personalWorkspacePath:path.join(root,'workspace'),themeRoot:path.join(root,'theme-assets'),
      repairSourceRoot:root,chinaDayCacheRoot:path.join(root,'cache'),newsRoot:path.join(root,'news'),
      publicShares:{getClientId:()=> 'synthetic-client'},diagnostic:()=>{}});
    assert.equal(app.host.status,'prepared');await assert.rejects(StoreOwner.acquire(filename),/CONFLICT/);
    await app.close();app=undefined;
    const next=await StoreOwner.acquire(filename);await next.release();
  }finally{await app?.close();await fs.rm(root,{recursive:true,force:true});}
});

test('production restart releases an inherited service fence and drains engines without saved concurrency settings',async()=>{
  process.env.RELAY_ACCESS_TOKEN='synthetic-production-application';
  const {prepareStoredProductionApplication}=await import('./stored-production-application.js');
  const f=fixture();let app:Awaited<ReturnType<typeof prepareStoredProductionApplication>>|undefined;
  try{
    const seed=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});await seed.close();
    f.mutate(`DELETE FROM engine_resource_leases;UPDATE sessions SET active_attempt_id=NULL,status='idle';
      INSERT INTO engine_concurrency_settings(resource_key,engine_id,max_active_turns,updated_by_user_id,updated_at) VALUES('codex:default','codex',5,'owner',1);
      INSERT INTO _relay_maintenance_fence(singleton,fence_id,engine_id,acquired_at) VALUES(1,'managed:11111111-1111-4111-8111-111111111111',NULL,1)`);
    app=await prepareStoredProductionApplication({root:f.directory,storage:{filename:f.filename,storeId:'store',generation:2,defaultConcurrency:{'codebuddy:default':2}},
      codexHome:path.join(f.directory,'codex'),personalWorkspacePath:f.directory,themeRoot:path.join(f.directory,'theme'),repairSourceRoot:f.directory,
      chinaDayCacheRoot:path.join(f.directory,'cache'),newsRoot:path.join(f.directory,'news'),publicShares:{getClientId:()=> 'synthetic'},diagnostic:()=>{}});
    // Skip external news/provider startup; keep the real host activation, maintenance handoff and scheduler/Worker path.
    app.services.recover=async()=>{};app.services.resume=async()=>{};
    assert.equal(f.scalar('SELECT count(*) FROM _relay_maintenance_fence'),1);
    await app.activate();assert.equal(app.host.status,'ready');assert.equal((await app.app.request('/api/health')).status,200);
    assert.equal(f.scalar('SELECT count(*) FROM _relay_maintenance_fence'),0);
    for(const key of ['codex:default','codebuddy:default','opencode:default','zcode:default']){
      assert.deepEqual(await app.host.port.readSchedulerState({principal:{kind:'system',purpose:'scheduler'},resourceKey:key}),{cooldownUntil:null,probeAttemptId:null});
      const current=await app.host.port.readConcurrency({principal:{kind:'user',userId:'owner',authSessionHash:'auth-owner'},resourceKey:key});
      if(key==='codex:default')assert.equal(current.maxActiveTurns,5);
      if(key==='codebuddy:default')assert.equal(current.maxActiveTurns,2);
    }
    assert.equal(f.scalar('SELECT count(*) FROM engine_concurrency_settings'),1,'defaults must not overwrite saved settings or create rows');
    await assert.rejects(fs.stat(path.join(f.directory,'news')),{code:'ENOENT'});
  }finally{await app?.close();f.cleanup();}
});
