import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { WORKSPACE_ID, WORKSPACE_CONNECTION_SCOPE } from './workspace-context.js';
import type { CoreCommand,CoreStoragePort,StoragePrincipal } from '../storage/contracts.js';
import { StoredWorkspaceConsole } from './stored-workspace-console.js';
import { createStoredWorkspaceConsoleRouter } from '../routes/stored-workspace-console.js';
import { buildWorkspaceDashboard,WORKSPACE_DASHBOARD_MAX_BYTES } from './dashboard-projection.js';
import { FIXED_WORKSPACE_PATH } from './workspace-snapshot.js';
import type { TaskRegistryProjection } from './task-registry-reader.js';
import { hashSessionToken } from '../auth/session.js';
import { WorkspaceConsoleDashboardDtoSchema } from '../contracts/index.js';
import { requireWorkspaceRoot } from './workspace-config.js';
import { readWorkspaceRuns } from './workspace-runs-reader.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { feishuReadBatch } from '../integrations/feishu/read-batch.js';
const project='11111111-1111-4111-8111-111111111111',session='22222222-2222-4222-8222-222222222222',draft='33333333-3333-4333-8333-333333333333',foreign='44444444-4444-4444-8444-444444444444';
const token=(id:string)=>`synthetic-workspace-${id}`,principal=(id='admin')=>({kind:'user' as const,userId:id,authSessionHash:hashSessionToken(token(id))});
const registry=(title='Task'):TaskRegistryProjection=>({schemaVersion:1,generatedAt:'2026-11-06',tasks:[{id:'task-one',title,description:null,status:'active',taskPath:null,taskDocumentPath:null,horizon:null,nextAction:null,waitingOn:null,statusBasis:null,verification:null,lastVerifiedAt:null,startedAt:null,completedAt:null,feishuWorkItemIds:[]}]});
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function prepared(){
  const f=fixture();f.mutate(`INSERT INTO projects(id,owner_user_id,path,name) VALUES('${project}','owner','${FIXED_WORKSPACE_PATH}','Workspace');
    INSERT INTO sessions(id,owner_user_id,project_id,title,status,engine,message_revision) VALUES('${session}','owner','${project}','Workspace session','completed','codebuddy',1),('${draft}','owner','${project}','Draft','idle','codex',0),('${foreign}','owner','project','Wrong workspace','completed','codebuddy',1);
    INSERT INTO messages(id,session_id,role,content,created_at) VALUES('workspace-message','${session}','user','${'x'.repeat(4000)}',1),('foreign-message','${foreign}','user','outside',1);
    CREATE TABLE workspace_snapshots(source TEXT NOT NULL,identity_key TEXT NOT NULL,schema_version INTEGER NOT NULL,data_json TEXT NOT NULL,saved_at INTEGER NOT NULL,PRIMARY KEY(source,identity_key))`);
  for(const id of ['admin','owner'])f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${principal(id).authSessionHash}','${id}',${Date.now()+600000})`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'workspace-test',generation:1,initialize:true});const services:StoredWorkspaceConsole[]=[];
  const hooks={registry:async()=>registry(),listRuns:async()=>[],activityDurations:async()=>new Map<string,number>()};
  const make=(overrides:Partial<ConstructorParameters<typeof StoredWorkspaceConsole>[0]>={})=>{const service=new StoredWorkspaceConsole({port,storeId:'workspace-test',generation:1,registry:()=>hooks.registry(),listRuns:()=>hooks.listRuns(),activityDurations:()=>hooks.activityDurations(),...overrides});services.push(service);return service;};
  const request=(command:CoreCommand,key:string=randomUUID(),actor:StoragePrincipal=principal())=>({protocolVersion:1 as const,storeId:'workspace-test',workerGeneration:1,requestId:randomUUID(),operationId:key,principal:actor,command});
  const exec=(command:CoreCommand,key?:string,actor?:StoragePrincipal)=>port.execute(request(command,key,actor));
  const ok=async(command:CoreCommand,key?:string,actor?:StoragePrincipal):Promise<any>=>{const result=await exec(command,key,actor);assert.equal(result.state,'committed');return result.state==='committed'?result.value:null;};
  const proxy=(overrides:Partial<CoreStoragePort>)=>new Proxy(port,{get(target,key){const value=Reflect.get(overrides,key)??Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as CoreStoragePort;
  const app=(service=make())=>new Hono().route('/api/workspace-console',createStoredWorkspaceConsoleRouter({port,service}));
  const headers=(id='admin',key:string|null=randomUUID(),origin:string|null=null)=>{const h=new Headers({cookie:`relay_session=${token(id)}`,'content-type':'application/json'});if(key!==null)h.set('x-relay-operation-id',key);if(origin!==null)h.set('origin',origin);return h;};
  const snapshot=()=>WorkspaceConsoleDashboardDtoSchema.parse(buildWorkspaceDashboard(registry(),[],[],[],1));
  return{f,port,make,hooks,request,exec,ok,proxy,app,headers,snapshot,cleanup:async()=>{await Promise.all(services.map(s=>s.close()));await port.close();f.cleanup();}};
}

test('missing optional configuration shows an actionable notice in Native workbench responses',async()=>{
  const p=await prepared();try{
    const unavailable=async()=>{requireWorkspaceRoot(undefined,{workspaceRoot:'',configured:false,error:null});throw new Error('unreachable');};
    const service=p.make({registry:unavailable});
    const app=new Hono().route('/api/workspace-console',createStoredWorkspaceConsoleRouter({port:p.port,service,snapshots:{responsibility:unavailable}}));
    const dashboard=await app.request('/api/workspace-console/dashboard?refresh=1',{headers:p.headers()});
    assert.equal(dashboard.status,200);
    const body=await dashboard.json();
    assert.equal(body.sourceAvailable.registry,false);
    assert.match(body.errors.join(' '),/workbench\.local\.conf.*WORKSPACE_ROOT/);
    const report=await app.request('/api/workspace-console/responsibility',{headers:p.headers()});
    assert.equal(report.status,422);
    assert.match(JSON.stringify(await report.json()),/WORKSPACE_CONFIG_REQUIRED/);
    assert.equal((await p.port.readFrontendAccess({principal:principal(),resource:null}))?.allowed,true);
  }finally{await p.cleanup();}
});

test('authenticated responsibility HTTP reads own separate Feishu reuse scopes',async()=>{
  const p=await prepared();try{
    const owner={},scopes:unknown[]=[];
    const app=new Hono().route('/api/workspace-console',createStoredWorkspaceConsoleRouter({port:p.port,service:p.make(),snapshots:{responsibility:async()=>{
      const scope=feishuReadBatch(owner);assert(scope);scopes.push(scope);
      throw new Error('synthetic provider failure');
    }}}));
    await app.request('/api/workspace-console/responsibility?refresh=1',{headers:p.headers()});
    await app.request('/api/workspace-console/responsibility?refresh=1',{headers:p.headers()});
    assert.equal(scopes.length,2);assert.notEqual(scopes[0],scopes[1]);assert.equal(feishuReadBatch(owner),undefined);
    await app.request('/api/workspace-console/responsibility',{headers:p.headers('owner')});
    assert.equal(scopes.length,2,'a denied user must not enter the provider read scope');
  }finally{await p.cleanup();}
});

test('refresh stores and returns remote executions with no display name through the real reader', async () => {
  const p = await prepared();
  const root = await mkdtemp(path.join(tmpdir(), 'relay-refresh-runs-'));
  try {
    const directory = path.join(root, 'tasks/task-one/remote');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'runs-registry.json'), JSON.stringify({ runs: [{ location: 'remote', run_id: 'remote-job', status: 'running' }] }));
    const service = p.make({ listRuns: () => readWorkspaceRuns(root) });
    const app = p.app(service);
    for (const query of ['?refresh=1', '']) {
      const response = await app.request(`/api/workspace-console/dashboard${query}`, { headers: p.headers() });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.runs[0].runId, 'remote-job');
      assert.equal(body.runs[0].displayName, null);
    }
  } finally { await p.cleanup(); await rm(root, { recursive: true, force: true }); }
});

test('Feishu first-send validates the cached source and current projections retain only live associated sessions',async()=>{
  const p=await prepared();try{
    const service=p.make({hasFeishuWorkItem:async(_actor,id)=>id==='feishu:9001000015'});
    assert.deepEqual(await service.prepareFirstSendLink(principal(),'feishu:9001000015',draft),{taskId:'feishu:9001000015',workspacePath:FIXED_WORKSPACE_PATH,workspaceId:WORKSPACE_ID,targetRef:'feishu:9001000015',connectionScope:WORKSPACE_CONNECTION_SCOPE});
    await assert.rejects(service.prepareFirstSendLink(principal(),'feishu:999',draft),{code:'NOT_FOUND'});
    await service.link(principal(),'feishu:9001000015',session,randomUUID(),true);
    assert.equal(p.f.scalar('SELECT feishu_work_item_id FROM workspace_console_links'),'9001000015');
    const fresh=await service.getDashboard(principal(),true);
    assert.deepEqual(fresh.sessions[0]!.feishuWorkItemIds,['9001000015']);assert.equal(fresh.unlinkedSessions.length,0);
    const reloaded=await p.make().getDashboard(principal());assert.deepEqual(reloaded.sessions[0]!.feishuWorkItemIds,['9001000015']);
    p.f.mutate(`UPDATE sessions SET deleted_at=1 WHERE id='${session}'`);
    assert.equal((await service.getDashboard(principal())).sessions.length,0);
    p.f.mutate(`UPDATE sessions SET deleted_at=NULL WHERE id='${session}'`);
    assert.deepEqual((await service.getDashboard(principal())).sessions[0]!.feishuWorkItemIds,['9001000015']);
  }finally{await p.cleanup();}
});

test('legacy Feishu launch text alone does not establish a verified connection association',async()=>{
  const p=await prepared();try{
    const service=p.make();
    p.f.mutate("UPDATE messages SET content='请处理飞书工作项「Synthetic」（ID：9001000015）。先核查飞书工作项与工作区实际状态，再确定下一步。' WHERE id='workspace-message'");
    assert.deepEqual((await service.getDashboard(principal(),true)).sessions[0]!.feishuWorkItemIds,[]);
    p.f.mutate("UPDATE messages SET content='讨论飞书工作项 Synthetic，ID：9001000015' WHERE id='workspace-message'");
    assert.deepEqual((await service.getDashboard(principal())).sessions[0]!.feishuWorkItemIds,[]);
    p.f.mutate(`INSERT INTO messages(id,session_id,role,content,created_at) VALUES('later-mention','${session}','user','请处理飞书工作项「Synthetic」（ID：9001000015）。先核查飞书工作项与工作区实际状态，再确定下一步。',2)`);
    assert.deepEqual((await service.getDashboard(principal())).sessions[0]!.feishuWorkItemIds,[]);
  }finally{await p.cleanup();}
});

test('one session can retain multiple exact targets; unbinding and deletion never remove other task relations', async () => {
  const p=await prepared();
  try {
    const service=p.make({hasFeishuWorkItem:async()=>true,allowLocalFeishuLinks:true});
    await service.link(principal(),'task-one',session,randomUUID(),true,'feishu:1000000001');
    await service.link(principal(),'task-one',session,randomUUID(),true,'feishu:1000000002');
    assert.equal(p.f.scalar('SELECT count(*) FROM workspace_console_links'),2);
    await service.link(principal(),'task-one',session,randomUUID(),false,'feishu:1000000001');
    assert.equal(p.f.scalar('SELECT count(*) FROM workspace_console_links'),1);
    assert.equal(p.f.scalar('SELECT target_ref FROM workspace_console_links'),'feishu:1000000002');
    assert.equal((await service.getDashboard(principal(),true)).tasks[0].sessionIds.length,1);
    p.f.mutate(`UPDATE sessions SET deleted_at=1 WHERE id='${session}'`);
    assert.equal((await service.getDashboard(principal())).sessions.length,0);
    assert.equal(p.f.scalar('SELECT count(*) FROM workspace_console_links'),1);
    p.f.mutate(`UPDATE sessions SET deleted_at=NULL WHERE id='${session}'`);
    assert.equal((await service.getDashboard(principal())).tasks[0].sessionIds.length,1);
  } finally {await p.cleanup();}
});

test('unbound workbench rejects joint local/Feishu associations but permits independent targets',async()=>{
  const p=await prepared();try{
    const service=p.make({hasFeishuWorkItem:async()=>true});
    await assert.rejects(service.link(principal(),'task-one',session,randomUUID(),true,'feishu:1000000001'),{code:'INVALID_ARGUMENT'});
    await service.link(principal(),'task-one',session,randomUUID(),true);
    await service.link(principal(),'feishu:1000000001',session,randomUUID(),true);
    assert.equal(p.f.scalar('SELECT count(*) FROM workspace_console_links'),2);
  }finally{await p.cleanup();}
});

test('first-send task link requires a current admin, existing registry task and an empty fixed-workspace session',async()=>{
  const p=await prepared();try{
    const service=p.make();assert.deepEqual(await service.prepareFirstSendLink(principal(),'task-one',draft),{taskId:'task-one',workspacePath:FIXED_WORKSPACE_PATH,workspaceId:WORKSPACE_ID});
    await assert.rejects(service.prepareFirstSendLink(principal('owner'),'task-one',draft),{code:'FORBIDDEN'});
    await assert.rejects(service.prepareFirstSendLink(principal(),'missing-task',draft),{code:'NOT_FOUND'});
    await assert.rejects(service.prepareFirstSendLink(principal(),'task-one',foreign),{code:'NOT_FOUND'});
    await assert.rejects(service.prepareFirstSendLink(principal(),'task-one',session),{code:'CONFLICT'});
    p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");await assert.rejects(service.prepareFirstSendLink(principal(),'task-one',draft),{code:'FORBIDDEN'});
    assert.equal(p.f.scalar('SELECT count(*) FROM workspace_console_links'),0);
  }finally{await p.cleanup();}
});

test('Native workspace operation records retain admin authentication and forward validated pagination',async()=>{
  const p=await prepared();try{
    const calls:unknown[][]=[];
    const app=new Hono().route('/api/admin/workspace-console',createStoredWorkspaceConsoleRouter({port:p.port,service:p.make(),operations:{get:async(...args)=>{
      calls.push(args);return{parentId:args[1],rangeStart:'2026-11-01T00:00:00.000Z',rangeEnd:'2026-11-10T00:00:00.000Z',events:[],hasMore:false,cursor:null};
    }}}));
    const url='/api/admin/workspace-console/operations/9001000037?anchor=2026-11-10T00%3A00%3A00Z&cursor=abc&refresh=1';
    assert.equal((await app.request(url)).status,401);assert.equal((await app.request(url,{headers:p.headers('owner')})).status,403);assert.equal(calls.length,0);
    const response=await app.request(url,{headers:p.headers()});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.deepEqual(calls[0],[{userId:'admin',role:'admin'},'9001000037','2026-11-10T00:00:00Z','abc',true]);
    assert.equal((await app.request(url+'&extra=1',{headers:p.headers()})).status,400);assert.equal(calls.length,1);
  }finally{await p.cleanup();}
});

test('workspace current reads require current admin and include only non-draft sessions in the fixed workspace',async()=>{
  const p=await prepared();try{const state=await p.port.readWorkspaceState({principal:principal()});assert.deepEqual(state.sessions.map(s=>s.sessionId),[session]);assert.equal(state.sessions[0]!.latestMessage!.length,240);
    await assert.rejects(p.port.readWorkspaceState({principal:principal('owner')}),{code:'FORBIDDEN'});await assert.rejects(p.port.readWorkspaceDashboard({principal:principal('owner')}),{code:'FORBIDDEN'});
    p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='admin'");await assert.rejects(p.port.readWorkspaceState({principal:principal()}),{code:'FORBIDDEN'});
  }finally{await p.cleanup();}
});
test('link/unlink and fixed metadata admin audit commit atomically, with exact receipt replay',async()=>{
  const p=await prepared();try{const key=randomUUID(),command={name:'workspace.linkSession' as const,input:{linkId:randomUUID(),taskId:'task-one',sessionId:session}};
    await p.ok(command,key);await p.ok(command,key);assert.equal(p.f.scalar('SELECT count(*) FROM workspace_console_links'),1);assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE action='session.update'"),2);
    assert.equal((await p.port.readWorkspaceState({principal:principal()})).links[0]!.relation_source,'explicit');
    for(const id of [draft,foreign])assert.equal((await p.exec({...command,input:{...command.input,linkId:randomUUID(),sessionId:id}})).state,'rejected');
    await p.ok({name:'workspace.unlinkSession',input:{taskId:'task-one',sessionId:session}});assert.equal(p.f.scalar('SELECT count(*) FROM workspace_console_links'),0);
    p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");assert.equal((await p.exec(command,key)).state,'rejected');await assert.rejects(p.port.lookup({storeId:'workspace-test',operationId:key,principal:principal()}),{code:'FORBIDDEN'});
  }finally{await p.cleanup();}
});
test('audit or operation receipt failure rolls link writes back without full database export',async()=>{
  const p=await prepared();try{const key=randomUUID(),input={linkId:randomUUID(),taskId:'task-one',sessionId:session},command={name:'workspace.linkSession' as const,input};
    p.f.mutate("CREATE TRIGGER workspace_audit_failure BEFORE INSERT ON admin_audit_events WHEN NEW.result='started' BEGIN SELECT RAISE(ABORT,'synthetic');END");
    assert.equal((await p.exec(command,key)).state,'unknown');assert.equal(p.f.scalar('SELECT count(*) FROM workspace_console_links'),0);p.f.mutate('DROP TRIGGER workspace_audit_failure');
    p.f.mutate("CREATE TRIGGER workspace_receipt_failure BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='workspace.linkSession' BEGIN SELECT RAISE(ABORT,'synthetic');END");
    assert.equal((await p.exec(command,key)).state,'unknown');assert.equal(p.f.scalar('SELECT count(*) FROM admin_audit_events'),0);assert.equal(p.f.scalar('SELECT count(*) FROM workspace_console_links'),0);
    p.f.mutate('DROP TRIGGER workspace_receipt_failure');await p.ok(command,key);assert.equal(p.f.scalar('SELECT count(*) FROM workspace_console_links'),1);
  }finally{await p.cleanup();}
});
test('pending soft deletion fences workspace mutations using their session scope',async()=>{
  const p=await prepared();try{await p.ok({name:'trash.prepareSoftDelete',input:{jobId:randomUUID(),kind:'session',resourceId:session}},undefined,principal('owner'));
    for(const command of [{name:'workspace.linkSession',input:{linkId:randomUUID(),taskId:'task-one',sessionId:session}},{name:'workspace.unlinkSession',input:{taskId:'task-one',sessionId:session}}] as CoreCommand[]){const result=await p.exec(command);assert.equal(result.state,'rejected');if(result.state==='rejected')assert.equal(result.code,'CONFLICT');}
  }finally{await p.cleanup();}
});
test('snapshot tickets reject late fetches and forbid changing a version after it was applied',async()=>{
  const p=await prepared();try{const first=await p.ok({name:'workspace.beginSnapshot',input:{}}),second=await p.ok({name:'workspace.beginSnapshot',input:{}}),value=p.snapshot();
    await p.ok({name:'workspace.saveSnapshot',input:{version:second.version,value}});
    const old=await p.exec({name:'workspace.saveSnapshot',input:{version:first.version,value}});assert.equal(old.state,'rejected');if(old.state==='rejected')assert.equal(old.code,'SUPERSEDED');
    const conflict=await p.exec({name:'workspace.saveSnapshot',input:{version:second.version,value:{...value,capturedAt:2}}});assert.equal(conflict.state,'rejected');if(conflict.state==='rejected')assert.equal(conflict.code,'CONFLICT');
    const current=await p.port.readWorkspaceDashboard({principal:principal()});assert.equal(current!.version,second.version);assert.equal(current!.value.capturedAt,1);
  }finally{await p.cleanup();}
});
test('cached dashboard reloads current sessions and explicit links without rereading task/run files',async()=>{
  const p=await prepared();try{const service=p.make();await service.link(principal(),'task-one',session,randomUUID(),true);assert.deepEqual((await service.getDashboard(principal())).tasks[0]!.sessionIds,[session]);
    p.hooks.registry=async()=>{throw new Error('must not reload');};p.hooks.listRuns=async()=>{throw new Error('must not reload');};
    await p.ok({name:'workspace.unlinkSession',input:{taskId:'task-one',sessionId:session}});assert.deepEqual((await service.getDashboard(principal())).tasks[0]!.sessionIds,[]);
    p.f.mutate(`UPDATE sessions SET deleted_at=1 WHERE id='${session}'`);const cached=await service.getDashboard(principal());assert.equal(cached.sessions.length,0);assert.equal(cached.sourceMeta!.state,'snapshot');
    const raw=String(p.f.scalar('SELECT data_json FROM workspace_snapshots'));assert.ok(raw.includes(session));
  }finally{await p.cleanup();}
});
test('a slower forced refresh cannot overwrite or return an older task snapshot',async()=>{
  const p=await prepared(),entered=gate(),release=gate();try{let calls=0;const service=p.make({registry:async()=>{if(++calls===1){entered.resolve();await release.promise;return registry('Older');}return registry('Newer');}});
    const old=service.getDashboard(principal(),true);await entered.promise;assert.equal((await service.getDashboard(principal(),true)).tasks[0]!.title,'Newer');release.resolve();assert.equal((await old).tasks[0]!.title,'Newer');
  }finally{release.resolve();await p.cleanup();}
});
test('failed external refresh preserves snapshot task data but refreshes current session actions',async()=>{
  const p=await prepared();try{const service=p.make();await service.link(principal(),'task-one',session,randomUUID(),true);await service.getDashboard(principal());await service.link(principal(),'task-one',session,randomUUID(),false);
    p.hooks.registry=async()=>{throw new Error('private external path');};const result=await service.getDashboard(principal(),true);assert.equal(result.tasks.length,1);assert.deepEqual(result.tasks[0]!.sessionIds,[]);assert.equal(result.sourceMeta!.state,'failed_snapshot');assert.ok(!JSON.stringify(result).includes('private external'));
    assert.equal((await service.getDashboard(principal())).sourceMeta!.state,'failed_snapshot');
  }finally{await p.cleanup();}
});
test('role changes and shutdown during registry I/O prevent a queued association write',async()=>{
  for(const mode of ['role','close']){const p=await prepared(),entered=gate(),release=gate();try{const service=p.make({registry:async()=>{entered.resolve();await release.promise;return registry();}}),run=service.link(principal(),'task-one',session,randomUUID(),true);await entered.promise;
    let closing:Promise<void>|undefined;if(mode==='role')p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");else closing=service.close();release.resolve();await assert.rejects(run);await closing;assert.equal(p.f.scalar('SELECT count(*) FROM workspace_console_links'),0);
  }finally{release.resolve();await p.cleanup();}}
});
test('unknown cache save resolves from current ticket projection, while receipt rollback permits exact retry',async()=>{
  const p=await prepared();try{const port=p.proxy({execute:async(request:any)=>{const result=await p.port.execute(request);return request.command.name==='workspace.saveSnapshot'?{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'}:result;},lookup:async()=>{throw new Error('unavailable');}} as any);
    assert.equal((await p.make({port}).getDashboard(principal(),true)).tasks[0]!.title,'Task');
    const ticket=await p.ok({name:'workspace.beginSnapshot',input:{}}),key=randomUUID(),command={name:'workspace.saveSnapshot' as const,input:{version:ticket.version,value:p.snapshot()}};
    p.f.mutate("CREATE TRIGGER workspace_cache_failure BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='workspace.saveSnapshot' BEGIN SELECT RAISE(ABORT,'synthetic');END");assert.equal((await p.exec(command,key)).state,'unknown');
    const old=(await p.port.readWorkspaceDashboard({principal:principal()}))!;assert.notEqual(old.version,ticket.version);p.f.mutate('DROP TRIGGER workspace_cache_failure');await p.ok(command,key);assert.equal((await p.port.readWorkspaceDashboard({principal:principal()}))!.version,ticket.version);
  }finally{await p.cleanup();}
});
test('workspace HTTP authenticates admin, validates strict scope, Origin and retained operation keys',async()=>{
  const p=await prepared();try{const server=p.app(),url='/api/workspace-console';
    assert.equal((await server.request(url+'/dashboard')).status,401);assert.equal((await server.request(url+'/dashboard',{headers:p.headers('owner')})).status,403);
    assert.equal((await server.request(url+'/dashboard?path=injected',{headers:p.headers()})).status,400);
    const target=url+'/tasks/task-one/sessions';assert.equal((await server.request(target,{method:'POST',headers:p.headers('admin',null),body:JSON.stringify({sessionId:session})})).status,400);
    assert.equal((await server.request(target,{method:'POST',headers:p.headers('admin',randomUUID(),'https://hostile.invalid'),body:JSON.stringify({sessionId:session})})).status,403);
    assert.equal((await server.request(target,{method:'POST',headers:p.headers(),body:JSON.stringify({sessionId:session,path:FIXED_WORKSPACE_PATH})})).status,400);
    assert.equal((await server.request(target,{method:'POST',headers:p.headers(),body:'x'.repeat(1025)})).status,413);
    const key=randomUUID(),link=await server.request(target,{method:'POST',headers:p.headers('admin',key),body:JSON.stringify({sessionId:session})});assert.equal(link.status,200);assert.equal(link.headers.get('x-relay-operation-id'),key);
    const dashboard=await server.request(url+'/dashboard',{headers:p.headers()});assert.equal(dashboard.status,200);assert.equal(dashboard.headers.get('cache-control'),'private, no-store');assert.deepEqual((await dashboard.json() as any).tasks[0].sessionIds,[session]);
    assert.equal((await server.request(url+'/dashboard?refresh=1',{headers:p.headers()})).status,200);
    assert.equal((await server.request(`${target}/${session}`,{method:'DELETE',headers:p.headers()})).status,200);
  }finally{await p.cleanup();}
});
test('workspace state and cached JSON use explicit bounds without changing oversized stored data',async()=>{
  const p=await prepared();try{
    const oversized=WORKSPACE_DASHBOARD_MAX_BYTES+2;
    p.f.mutate(`INSERT INTO workspace_snapshots VALUES('dashboard','admin:${WORKSPACE_ID}:${FIXED_WORKSPACE_PATH}',1,replace(hex(zeroblob(${oversized/2})),'0','x'),1)`);
    await assert.rejects(p.port.readWorkspaceDashboard({principal:principal()}),{code:'PAYLOAD_TOO_LARGE'});assert.equal(p.f.scalar('SELECT length(data_json) FROM workspace_snapshots'),oversized);
    p.f.mutate(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1001) INSERT INTO workspace_console_links(id,workspace_id,workspace_path,task_id,session_id,feishu_work_item_id,run_id,relation_source,confidence,created_at,updated_at)
      SELECT 'bounded-'||i,'${WORKSPACE_ID}','${FIXED_WORKSPACE_PATH}','bounded-task-'||i,'${session}','','','explicit','high',1,1 FROM n`);
    await assert.rejects(p.port.readWorkspaceState({principal:principal()}),{code:'PAYLOAD_TOO_LARGE'});assert.equal(p.f.scalar('SELECT count(*) FROM workspace_console_links'),1001);
  }finally{await p.cleanup();}
});

test('legacy dashboards above 1 MiB remain readable and refresh through the real Worker and HTTP route',async()=>{
  const p=await prepared();try{
    const large=registry();large.tasks=Array.from({length:160},(_,i)=>({...large.tasks[0]!,id:`task-${i}`,description:'合成台账',nextAction:'合成下一步'.repeat(1000)}));
    const value=WorkspaceConsoleDashboardDtoSchema.parse(buildWorkspaceDashboard(large,[],[],[],1));
    const json=JSON.stringify(value);assert.ok(Buffer.byteLength(json)>1024*1024);assert.ok(Buffer.byteLength(json)<WORKSPACE_DASHBOARD_MAX_BYTES);
    p.f.mutate(`INSERT INTO workspace_snapshots VALUES('dashboard','admin:${FIXED_WORKSPACE_PATH}',1,'${json.replaceAll("'","''")}',1)`);
    p.hooks.registry=async()=>large;
    const app=p.app();
    for(const suffix of ['', '?refresh=1', '']){
      const response=await app.request('/api/workspace-console/dashboard'+suffix,{headers:p.headers()});
      assert.equal(response.status,200);const body=await response.json() as any;
      assert.equal(body.tasks.length,160);assert.equal(body.tasks[0].nextAction,large.tasks[0]!.nextAction);
    }
    assert.ok(Number(p.f.scalar('SELECT length(CAST(data_json AS BLOB)) FROM workspace_snapshots'))>1024*1024);
  }finally{await p.cleanup();}
});
test('cached source scope cannot be supplied by a browser or changed through the private snapshot command',async()=>{
  const p=await prepared();try{const ticket=await p.ok({name:'workspace.beginSnapshot',input:{}}),value={...p.snapshot(),workspacePath:'D:/injected-workspace'};
    const result=await p.exec({name:'workspace.saveSnapshot',input:{version:ticket.version,value}});assert.equal(result.state,'rejected');if(result.state==='rejected')assert.equal(result.code,'INVALID_ARGUMENT');
    assert.equal(p.f.scalar('SELECT count(*) FROM workspace_snapshots'),0);
  }finally{await p.cleanup();}
});

test('a joint delivery target from a previous Feishu connection remains a candidate and cannot resume a session',async()=>{
  const p=await prepared();try{
    const old=WORKSPACE_CONNECTION_SCOPE==='a'.repeat(64)?'b'.repeat(64):'a'.repeat(64);
    p.f.mutate(`INSERT INTO workspace_console_links(id,workspace_id,workspace_path,task_id,session_id,target_ref,connection_scope,relation_source,confidence,created_at,updated_at)
      VALUES('old-connection','${WORKSPACE_ID}','${FIXED_WORKSPACE_PATH}','task-one','${session}','feishu:123','${old}','explicit','high',1,1)`);
    const state=await p.port.readWorkspaceState({principal:principal()});
    assert.equal(state.links[0].relation_source,'candidate');
    assert.deepEqual(state.sessions[0].workspaceTargets,[]);
    const dashboard=await p.make().getDashboard(principal(),true);
    assert.deepEqual(dashboard.tasks[0].sessionIds,[]);
  }finally{await p.cleanup();}
});

test('duplicate nullable legacy links project one historical target without rewriting stored evidence',async()=>{
  const p=await prepared();try{
    for(const id of ['legacy-1','legacy-2'])p.f.mutate(`INSERT INTO workspace_console_links(id,workspace_id,workspace_path,task_id,session_id,feishu_work_item_id,run_id,relation_source,confidence,created_at,updated_at)
      VALUES('${id}','${WORKSPACE_ID}','${FIXED_WORKSPACE_PATH}','task-one','${session}',NULL,NULL,'explicit','high',1,1)`);
    const state=await p.port.readWorkspaceState({principal:principal()});
    assert.equal(state.links.length,2);
    assert.deepEqual(state.sessions[0].workspaceTargets,[{taskId:'task-one',targetRef:''}]);
    assert.equal(p.f.scalar('SELECT count(*) FROM workspace_console_links'),2);
  }finally{await p.cleanup();}
});
