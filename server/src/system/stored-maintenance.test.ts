import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { createStoredMaintenanceRegistry,readStoredWorkspaceRoots } from './stored-maintenance.js';
import { CodexMaintenanceAdapter } from './codex-maintenance.js';

test('Native maintenance composition blocks provider-idle upgrades using persisted leases and fails closed on DB loss',async()=>{
  const f=fixture(),port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const provider=new CodexMaintenanceAdapter({getVersionSnapshot:()=>({currentVersion:'1.0.0',latestVersion:'1.1.0',releaseOverview:null,updateAvailable:true,status:'success',checkedAt:1}),
    checkLatestVersion:async()=>({currentVersion:'1.0.0',latestVersion:'1.1.0',releaseOverview:null,updateAvailable:true,status:'success',checkedAt:1}),
    readRunningVersion:()=>null,readActiveTaskCount:async()=>0,readInstallSource:()=> 'official_npm_global',readReadiness:()=>({readiness:'ready',checkedAt:1})});
  const registry=createStoredMaintenanceRegistry(port,[provider]);
  try{
    const status=await registry.get('codex').getStatus();assert.equal(status.activeTaskCount,1);
    assert.equal(status.actions.find(action=>action.action==='upgrade_and_restart')?.enabled,false);
    assert.equal(status.actions.find(action=>action.action==='restart')?.interruptsActiveTasks,true);
    f.mutate("UPDATE projects SET path='"+f.directory.replaceAll("'","''")+"'");assert.deepEqual(await readStoredWorkspaceRoots(port),[f.directory]);
    f.mutate("DELETE FROM engine_resource_leases;UPDATE sessions SET status='idle'");
    assert.equal((await registry.get('codex').getStatus()).actions.find(action=>action.action==='upgrade_and_restart')?.enabled,true);
    await port.close();await assert.rejects(()=>registry.get('codex').getStatus());assert.deepEqual((await registry.getSnapshot()).engines[0].actions,[]);
  }finally{await port.close();f.cleanup();}
});
