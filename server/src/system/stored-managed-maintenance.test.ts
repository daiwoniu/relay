import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fixture,markRead } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { CodexMaintenanceAdapter } from './codex-maintenance.js';
import { createStoredManagedMaintenance } from './stored-managed-maintenance.js';
const admin={id:'admin',username:'admin',role:'admin' as const};
const environment=()=>({required:false,blockedByConflicts:false,server:{needed:false,reason:'ok'},client:{needed:false,reason:'ok'}});
const version=()=>({currentVersion:'1.0.0',latestVersion:'1.1.0',releaseOverview:null,updateAvailable:true,status:'success' as const,checkedAt:1});
const adapter=()=>new CodexMaintenanceAdapter({getVersionSnapshot:version,checkLatestVersion:async()=>version(),readRunningVersion:()=>null,
  readActiveTaskCount:()=>0,readInstallSource:()=> 'official_npm_global',readReadiness:()=>({readiness:'ready',checkedAt:1})});
async function until(check:()=>boolean){for(let n=0;n<200&&!check();n++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(check());}
class Launcher extends EventEmitter{
  env={RELAY_LAUNCHER_CONTROL_VERSION:'6'};sent:any[]=[];failCommit=false;
  send=(message:any,callback?:(error:Error|null)=>void)=>{
    this.sent.push(message);if(this.failCommit&&message.type==='engine_commit'){callback?.(new Error('delivery unknown'));return false;}
    callback?.(null);
    if(message.type==='engine_request')queueMicrotask(()=>this.emit('message',{...message,type:'engine_response',status:'accepted'}));
    if(message.type==='engine_commit')queueMicrotask(()=>this.emit('message',{...message,type:'engine_response',status:'completed'}));
    if(message.type==='restart_request')queueMicrotask(()=>this.emit('message',{...message,type:'restart_response',status:'accepted'}));
    if(message.type==='restart_commit')queueMicrotask(()=>this.emit('message',{...message,type:'restart_response',status:'completed'}));
    return true;
  };
}

test('Native managed maintenance closes transactional admission before launcher requests and releases only on known terminal',async()=>{
  const f=fixture();f.mutate("DELETE FROM engine_resource_leases;UPDATE sessions SET status='idle'");
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true}),launcher=new Launcher();
  const service=await createStoredManagedMaintenance({port,storeId:'store',generation:1,assertExclusiveWriter:async()=>{},adapters:[adapter()],processLike:launcher as any,inspectEnvironment:environment});
  try{
    const reserved=await service.maintenance.reserve({user:admin,engineId:'codex',action:'upgrade_and_restart'});
    assert.equal((await port.readMaintenanceState({principal:{kind:'system',purpose:'maintenance'}})).fence?.engineId,'codex');
    await assert.rejects(()=>service.recovery.requestRecovery({user:admin,action:'restart_relay',clientProtocolVersion:10}),/operation_in_progress/);
    const send={...markRead(),operationId:'late-prepared',command:{name:'turn.enqueue' as const,input:{sessionId:'late',attemptId:'late-attempt',messageId:'late-message',engineId:'codex' as const,resourceKey:'codex:default',content:'late',metadata:null,expectedPreferencesRevision:0,origin:{kind:'direct' as const},draft:{projectId:'project',title:'late',titleManuallySet:false}}}};
    assert.equal((await port.execute(send)).state,'rejected');assert.equal(f.scalar("SELECT COUNT(*) FROM sessions WHERE id='late'"),0);
    assert.equal(await service.maintenance.confirm(reserved.operationId,'codex','upgrade_and_restart'),true);
    await until(()=>!service.busy());assert.equal(service.maintenance.getOperation(reserved.operationId)?.status,'completed');
    assert.equal((await port.readMaintenanceState({principal:{kind:'system',purpose:'maintenance'}})).fence,null);
    const restart=await service.recovery.requestRecovery({user:admin,action:'restart_relay',clientProtocolVersion:10});
    if(restart.status!=='accepted')assert.fail();
    assert.equal((await port.readMaintenanceState({principal:{kind:'system',purpose:'maintenance'}})).fence?.engineId,null);
    assert.equal(await service.recovery.confirmOperation(restart.operationId,'relay'),true);await until(()=>!service.busy());
  }finally{await service.close();assert.equal(launcher.listenerCount('message'),0);await port.close();f.cleanup();}
});

test('unknown engine confirmation keeps durable admission closed across maintenance service restart',async()=>{
  const f=fixture();f.mutate("DELETE FROM engine_resource_leases;UPDATE sessions SET status='idle'");
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true}),launcher=new Launcher();launcher.failCommit=true;
  const options={port,storeId:'store',generation:1,assertExclusiveWriter:async()=>{},adapters:[adapter()],processLike:launcher as any,inspectEnvironment:environment};
  let service=await createStoredManagedMaintenance(options);
  try{
    const reserved=await service.maintenance.reserve({user:admin,engineId:'codex',action:'restart'});
    assert.equal(await service.maintenance.confirm(reserved.operationId,'codex','restart'),false);assert.equal(service.busy(),true);
    await service.close();service=await createStoredManagedMaintenance(options);assert.equal(service.busy(),true);
    await service.completeServiceStartup();assert.equal(service.busy(),true);
    await assert.rejects(()=>service.assertAdmission('codex'),/CONFLICT/);
    await assert.rejects(()=>service.recovery.requestRecovery({user:admin,action:'restart_relay',clientProtocolVersion:10}),/operation_in_progress/);
    assert.ok((await port.readMaintenanceState({principal:{kind:'system',purpose:'maintenance'}})).fence);
  }finally{await service.close();await port.close();f.cleanup();}
});

test('a successfully activated replacement backend releases only its inherited service fence',async()=>{
  const f=fixture();f.mutate("DELETE FROM engine_resource_leases;UPDATE sessions SET status='idle'");
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true}),launcher=new Launcher();
  const options={port,storeId:'store',generation:1,assertExclusiveWriter:async()=>{},adapters:[adapter()],processLike:launcher as any,inspectEnvironment:environment};
  let service=await createStoredManagedMaintenance(options);
  try{
    const reserved=await service.recovery.requestRecovery({user:admin,action:'restart_backend',clientProtocolVersion:10});
    assert.equal(reserved.status,'accepted');
    // Calling startup completion again on the old instance cannot release its current operation.
    await service.completeServiceStartup();assert.equal(service.busy(),true);
    await service.close();service=await createStoredManagedMaintenance(options);
    assert.equal(service.busy(),true);
    await assert.rejects(service.assertAdmission('codex'),/CONFLICT/);
    await service.completeServiceStartup();
    assert.equal(service.busy(),false);
    assert.equal((await service.recovery.getCapabilities(admin)).operationInProgress,false);
    assert.equal((await port.readMaintenanceState({principal:{kind:'system',purpose:'maintenance'}})).fence,null);
    await service.assertAdmission('codex');
    await service.completeServiceStartup();assert.equal(service.busy(),false);
  }finally{await service.close();assert.equal(launcher.listenerCount('message'),0);await port.close();f.cleanup();}
});

test('a task accepted before fence acquisition is observed again under the fence and blocks upgrade IPC',async()=>{
  const f=fixture();f.mutate("DELETE FROM engine_resource_leases;UPDATE sessions SET status='idle'");
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true}),launcher=new Launcher();let inject=true;
  const service=await createStoredManagedMaintenance({port,storeId:'store',generation:1,adapters:[adapter()],processLike:launcher as any,inspectEnvironment:environment,
    assertExclusiveWriter:async()=>{if(inject){inject=false;f.mutate("UPDATE sessions SET status='processing'");}}});
  try{
    await assert.rejects(()=>service.maintenance.reserve({user:admin,engineId:'codex',action:'upgrade_and_restart'}),/action_blocked/);
    await until(()=>!service.busy());assert.equal(launcher.sent.length,0);
    assert.equal((await port.readMaintenanceState({principal:{kind:'system',purpose:'maintenance'}})).fence,null);
  }finally{await service.close();await port.close();f.cleanup();}
});
