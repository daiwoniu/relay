import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import type { CoreCommand,CoreStoragePort } from './contracts.js';
import { hashSessionToken } from '../auth/session.js';
import { StoredProviderSnapshots } from '../services/stored-provider-snapshots.js';
import { CodexAccountSnapshotDtoSchema } from '../contracts/index.js';
import { Hono } from 'hono';
import { createStoredWorkspaceConsoleRouter } from '../routes/stored-workspace-console.js';
import { parseResponsibilityReport } from '../workspace-console/responsibility-report-source.js';
import { ServiceError } from '../services/errors.js';
const actor={kind:'user' as const,userId:'admin',authSessionHash:hashSessionToken('synthetic-provider-admin')};
const report=()=>({reportKind:'project_responsibility' as const,sourceUserKey:'user-one',todoEquivalent:false as const,generatedAt:'2026-11-06T04:00:00Z',fetchedAt:1000,servedFromCache:false,complete:true,stale:false,error:null,items:[],workbenchItems:[],localAssociated:[],counts:{current:0,stateResponsibility:0,upcoming:0}});
const official=(email='a@example.test',fetchedAt=1000)=>CodexAccountSnapshotDtoSchema.parse({fetchedAt,status:'ready',authMode:'chatgpt',email,planType:'pro',rateLimits:[],credits:{hasCredits:true,unlimited:false,remaining:12,currency:null},rateLimitResetCredits:null,usage:null,errorMessage:null});
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function prepared(){
  const f=fixture();f.mutate('CREATE TABLE workspace_snapshots(source TEXT,identity_key TEXT,schema_version INTEGER,data_json TEXT,saved_at INTEGER,PRIMARY KEY(source,identity_key))');
  f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${actor.authSessionHash}','admin',${Date.now()+600000})`);
  const state={identity:{projectKey:'project-one',userKey:'user-one'},report:report(),official:official(),calls:0,fail:false,limitsOk:true,usageOk:true};
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'provider-test',generation:1,initialize:true}),services:StoredProviderSnapshots[]=[];
  const make=(overrides:Partial<ConstructorParameters<typeof StoredProviderSnapshots>[0]>={})=>{const service=new StoredProviderSnapshots({port,storeId:'provider-test',generation:1,now:()=>2000,
    responsibilityIdentity:async()=>({...state.identity}),loadResponsibility:async()=>{state.calls++;if(state.fail)throw new Error('secret-provider-detail');return state.report;},
    loadOfficial:async()=>{state.calls++;if(state.fail)throw new Error('secret-provider-detail');return{snapshot:state.official,limitsOk:state.limitsOk,usageOk:state.usageOk};},...overrides});services.push(service);return service;};
  const request=(command:CoreCommand)=>({protocolVersion:1 as const,storeId:'provider-test',workerGeneration:1,requestId:randomUUID(),operationId:randomUUID(),principal:actor,command});
  const ok=async(command:CoreCommand):Promise<any>=>{const result=await port.execute(request(command));assert.equal(result.state,'committed');return result.state==='committed'?result.value:null;};
  const proxy=(overrides:Partial<CoreStoragePort>)=>new Proxy(port,{get(target,key){const value=Reflect.get(overrides,key)??Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as CoreStoragePort;
  return{f,port,state,make,request,ok,proxy,cleanup:async()=>{await Promise.all(services.map(s=>s.close()));await port.close();f.cleanup();}};
}
test('responsibility persists a source-specific snapshot and hydrates without contacting the source',async()=>{
  const p=await prepared();try{const first=await p.make().responsibility(actor);assert.equal(first.sourceMeta!.state,'live');const cached=await p.make().responsibility(actor);assert.equal(cached.servedFromCache,true);assert.equal(p.state.calls,1);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_provider_snapshot_versions'),1);}finally{await p.cleanup();}
});

test('responsibility preserves safe source failures without a cache and while retaining an older snapshot',async()=>{
  const p=await prepared();try{
    const error=new ServiceError(502,'飞书返回数据未通过结构或责任证据校验，本次报表未能更新','FEISHU_SOURCE_INVALID');
    const failed=p.make({loadResponsibility:async()=>{throw error;}});
    await assert.rejects(failed.responsibility(actor,true),caught=>caught===error);
    await p.make().responsibility(actor,true);
    const stale=await failed.responsibility(actor,true);
    assert.equal(stale.stale,true);assert.equal(stale.error,error.message);assert.equal(stale.sourceMeta?.error,error.message);
  }finally{await p.cleanup();}
});
test('responsibility connection/auth scope partitions snapshots even for the same project and user', async () => {
  const p = await prepared();
  try {
    let scope = 'a'.repeat(64);
    const service = p.make({ responsibilityIdentity: async () => ({ ...p.state.identity, scope }) });
    await service.responsibility(actor);
    scope = 'b'.repeat(64);
    await service.responsibility(actor);
    assert.equal(p.state.calls, 2);
    assert.equal(p.f.scalar('SELECT count(*) FROM workspace_snapshots'), 2);
    p.state.fail = true;
    scope = 'c'.repeat(64);
    await assert.rejects(service.responsibility(actor), { code: 'STORAGE_UNAVAILABLE' });
  } finally { await p.cleanup(); }
});
test('fresh parsed responsibility items with absent optional fields replace the old Native snapshot',async()=>{
  const p=await prepared();try{
    await p.make().responsibility(actor);
    const expected={projectKey:'project-one',userKey:'user-one'};
    const raw={report_kind:'project_responsibility',todo_equivalent:false,report_id:'synthetic-report',generated_at:'2026-11-10T05:00:00Z',source_user_key:expected.userKey,complete:true,
      integrity:{source_ids_exactly_once:true,retrieval_complete:true,classification_complete:true,source_complete:true,workbench_projection_complete:true},
      workbench_items:[{work_item_id:'7113099246',work_item_type:'story',project_key:expected.projectKey,name:'Synthetic parent',owner_user_key:expected.userKey,work_item_status:{state_key:'doing',is_archived_state:false},flow_finished:false,current_node_names:[],my_subtasks:[]}],
      business_items:[],items:[{work_item_id:'7113099246',project_key:expected.projectKey,name:'Synthetic current item',actionability:'current',personal_subtasks:[],shared_nodes:[],release:{}}],
      summary:{current_items:1,state_responsibility_items:0,upcoming_items:0}};
    const parsed=parseResponsibilityReport(raw,expected);
    const service=p.make({loadResponsibility:async()=>({...parsed,fetchedAt:3000})});
    const fresh=await service.responsibility(actor,true);
    assert.equal(fresh.fetchedAt,3000);assert.equal(fresh.items.length,1);assert.equal(fresh.sourceMeta!.state,'live');
    assert.equal(Object.hasOwn(fresh.items[0]!,'myRoleKeys'),false);assert.equal(Object.hasOwn(fresh.items[0]!,'baseOwnerIsMe'),false);
    assert.equal(Object.hasOwn(fresh.workbenchItems[0]!,'currentNodes'),false);
    assert.equal(await service.hasResponsibilityWorkItem(actor,'7113099246'),true);
    assert.equal(await service.hasResponsibilityWorkItem(actor,'999'),false);
    const cached=await p.make().responsibility(actor);assert.equal(cached.fetchedAt,3000);assert.equal(cached.items[0]!.workItemId,'7113099246');
  }finally{await p.cleanup();}
});
test('partial responsibility classification keeps diagnostics through Native snapshot hydration',async()=>{
  const p=await prepared();try{
    const source={...report(),complete:false,unverifiedCount:2};
    const service=p.make({loadResponsibility:async()=>source});
    const fresh=await service.responsibility(actor,true);
    assert.equal(fresh.unverifiedCount,2);assert.equal(fresh.complete,false);
    assert.equal(fresh.stale,false);assert.equal(fresh.error,null);assert.equal(fresh.sourceMeta!.state,'live');
    const cached=await p.make().responsibility(actor);
    assert.equal(cached.unverifiedCount,2);assert.equal(cached.complete,false);assert.equal(cached.servedFromCache,true);
  }finally{await p.cleanup();}
});

test('responsibility failure preserves same-identity data and redacts provider exceptions',async()=>{
  const p=await prepared();try{const s=p.make();await s.responsibility(actor);p.state.fail=true;const result=await s.responsibility(actor,true);assert.equal(result.stale,true);assert.equal(result.sourceMeta!.state,'failed_snapshot');assert.equal(JSON.stringify(result).includes('secret-provider-detail'),false);
    p.state.identity.userKey='different';await assert.rejects(s.responsibility(actor,true),{code:'STORAGE_UNAVAILABLE'});
  }finally{await p.cleanup();}
});
test('identity changes during responsibility reads refuse stale results without persisting them',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{const s=p.make({loadResponsibility:async()=>{entered.resolve();await release.promise;return report();}}),run=s.responsibility(actor);await Promise.race([entered.promise,run.then(()=>assert.fail('not entered'))]);p.state.identity.userKey='other';release.resolve();await assert.rejects(run,{code:'CONFLICT'});assert.equal(p.f.scalar('SELECT count(*) FROM workspace_snapshots'),0);}finally{release.resolve();await p.cleanup();}
});
test('official cold cache is explicitly unverified while a fresh full read is verified',async()=>{
  const p=await prepared();try{const s=p.make();assert.equal((await s.official(actor)).identityVerified,true);assert.equal((await s.official(actor)).identityVerified,true);assert.equal(p.state.calls,1);const cold=await p.make().official(actor);assert.equal(cold.identityVerified,false);assert.equal(cold.sourceMeta!.state,'snapshot');assert.equal(p.state.calls,1);}finally{await p.cleanup();}
});
test('partial account B never inherits account A credits and remains B on the next cached read',async()=>{
  const p=await prepared();try{const s=p.make();await s.official(actor);p.state.official=official('b@example.test');p.state.limitsOk=false;const b=await s.official(actor,true);assert.equal(b.email,'b@example.test');assert.equal(b.credits,null);assert.equal(b.identityVerified,true);assert.equal((await s.official(actor)).email,'b@example.test');assert.equal(p.state.calls,2);assert.equal(p.f.scalar('SELECT count(*) FROM workspace_snapshots'),1);}finally{await p.cleanup();}
});
test('failed official refresh preserves prior data but never preserves its verified status',async()=>{
  const p=await prepared();try{const s=p.make();await s.official(actor);p.state.fail=true;const value=await s.official(actor,true);assert.equal(value.email,'a@example.test');assert.equal(value.identityVerified,false);assert.equal(value.sourceMeta!.state,'failed_snapshot');assert.equal(JSON.stringify(value).includes('secret-provider-detail'),false);assert.equal((await s.official(actor)).identityVerified,false);}finally{await p.cleanup();}
});
test('invalidation fences an already-running RPC result and forces the next provider read',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{const s=p.make({loadOfficial:async()=>{entered.resolve();await release.promise;return{snapshot:official(),limitsOk:true,usageOk:true};}}),run=s.official(actor);await Promise.race([entered.promise,run.then(()=>assert.fail('not entered'))]);s.invalidateOfficial();release.resolve();await assert.rejects(run,{code:'CONFLICT'});assert.equal(p.f.scalar('SELECT count(*) FROM workspace_snapshots'),0);assert.equal((await s.official(actor)).identityVerified,true);}finally{release.resolve();await p.cleanup();}
});
test('global provider versions reject late accounts and order current identity independently of clock time',async()=>{
  const p=await prepared();try{const first=await p.ok({name:'cache.beginSnapshot',input:{source:'codex_official'}});await p.ok({name:'cache.saveSnapshot',input:{source:'codex_official',identityKey:'chatgpt:a@example.test',version:first.version,value:official('a@example.test',9000)}});
    const older=await p.ok({name:'cache.beginSnapshot',input:{source:'codex_official'}}),newer=await p.ok({name:'cache.beginSnapshot',input:{source:'codex_official'}});
    await p.ok({name:'cache.saveSnapshot',input:{source:'codex_official',identityKey:'chatgpt:b@example.test',version:newer.version,value:official('b@example.test',100)}});
    const late=await p.port.execute(p.request({name:'cache.saveSnapshot',input:{source:'codex_official',identityKey:'chatgpt:a@example.test',version:older.version,value:official()}}));assert.equal(late.state,'rejected');if(late.state==='rejected')assert.equal(late.code,'SUPERSEDED');assert.equal((await p.port.readProviderSnapshot({principal:actor,source:'codex_official',identityKey:null}))!.identityKey,'chatgpt:b@example.test');
  }finally{await p.cleanup();}
});
test('receipt failures roll snapshot, row version and applied observation back atomically',async()=>{
  const p=await prepared();try{const version=await p.ok({name:'cache.beginSnapshot',input:{source:'codex_official'}});p.f.mutate("CREATE TRIGGER cache_receipt_failure BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='cache.saveSnapshot' BEGIN SELECT RAISE(ABORT,'synthetic');END");
    await assert.rejects(p.make().official(actor,true));assert.equal(p.f.scalar('SELECT count(*) FROM workspace_snapshots'),0);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_provider_snapshot_versions'),0);assert.equal(p.f.scalar('SELECT sum(latest_applied) FROM _relay_storage_observations'),0);assert.ok(version.version);
  }finally{await p.cleanup();}
});
test('lost save replies are proven by the durable current snapshot',async()=>{
  const p=await prepared();try{const port=p.proxy({execute:async(request:any)=>{const result=await p.port.execute(request);return request.command.name==='cache.saveSnapshot'?{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'}:result;},lookup:async()=>{throw new Error('offline');}} as any);assert.equal((await p.make({port}).official(actor)).identityVerified,true);assert.equal(p.f.scalar('SELECT count(*) FROM workspace_snapshots'),1);}finally{await p.cleanup();}
});
test('current authority is rechecked before source reads, cache reads, commands and receipt replay',async()=>{
  const p=await prepared();try{const s=p.make();await s.official(actor);const request=p.request({name:'cache.beginSnapshot',input:{source:'codex_official'}});await p.port.execute(request);p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");await assert.rejects(s.official(actor),{code:'FORBIDDEN'});const replay=await p.port.execute(request);assert.equal(replay.state,'rejected');if(replay.state==='rejected')assert.equal(replay.code,'FORBIDDEN');await assert.rejects(p.port.readProviderSnapshot({principal:actor,source:'codex_official',identityKey:null}),{code:'FORBIDDEN'});assert.equal(p.state.calls,1);}finally{await p.cleanup();}
});
test('source identity mismatch and oversized persisted rows cannot cross the storage boundary',async()=>{
  const p=await prepared();try{const ticket=await p.ok({name:'cache.beginSnapshot',input:{source:'codex_official'}});const result=await p.port.execute(p.request({name:'cache.saveSnapshot',input:{source:'codex_official',identityKey:'chatgpt:wrong@example.test',version:ticket.version,value:official()}}));assert.equal(result.state,'rejected');p.f.mutate("INSERT INTO workspace_snapshots VALUES('codex_official','chatgpt:a@example.test',1,printf('%.*c',2097153,'x'),1000)");await assert.rejects(p.port.readProviderSnapshot({principal:actor,source:'codex_official',identityKey:null}),{code:'PAYLOAD_TOO_LARGE'});}finally{await p.cleanup();}
});

test('responsibility HTTP authenticates current admins and preserves refresh and trigger query semantics',async()=>{
  const p=await prepared();try{const snapshots=p.make(),service={getDashboard:async()=>{throw new Error('unused');},link:async()=>{throw new Error('unused');}},app=new Hono().route('/api/workspace-console',createStoredWorkspaceConsoleRouter({port:p.port,service,snapshots})),url='/api/workspace-console/responsibility',headers={cookie:'relay_session=synthetic-provider-admin'};
    assert.equal((await app.request(url)).status,401);assert.equal((await app.request(url+'?path=injected',{headers})).status,400);const result=await app.request(url+'?refresh=1&trigger=manual',{headers});assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'private, no-store');assert.equal((await result.json() as any).sourceUserKey,'user-one');assert.equal(p.state.calls,1);
    p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");assert.equal((await app.request(url,{headers})).status,403);assert.equal(p.state.calls,1);
  }finally{await p.cleanup();}
});

test('late partial responses cannot overwrite a newer full provider snapshot in memory',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{let calls=0;const s=p.make({loadOfficial:async()=>{
    if(++calls===1){entered.resolve();await release.promise;return{snapshot:official('a@example.test'),limitsOk:false,usageOk:false};}return{snapshot:official('b@example.test'),limitsOk:true,usageOk:true};
  }}),old=s.official(actor);await Promise.race([entered.promise,old.then(()=>assert.fail('not entered'))]);assert.equal((await s.official(actor,true)).email,'b@example.test');release.resolve();assert.equal((await old).email,'b@example.test');assert.equal((await s.official(actor)).email,'b@example.test');
  }finally{release.resolve();await p.cleanup();}
});

test('invalidation during the final cache read cannot relabel an old result with a new epoch',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{let latestReads=0;const port=p.proxy({readProviderSnapshot:async(input)=>{const value=await p.port.readProviderSnapshot(input);if(input.source==='codex_official'&&input.identityKey===null&&++latestReads===2){entered.resolve();await release.promise;}return value;}}),s=p.make({port}),run=s.official(actor);await Promise.race([entered.promise,run.then(()=>assert.fail('not entered'))]);s.invalidateOfficial();release.resolve();await assert.rejects(run,{code:'CONFLICT'});assert.equal((await s.official(actor)).identityVerified,true);assert.equal(p.state.calls,2);
  }finally{release.resolve();await p.cleanup();}
});
