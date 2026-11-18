import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from './storage/worker-client.js';
import { hashSessionToken } from './auth/session.js';
import { StoredRuntimeGraph } from './ws/stored-runtime-graph.js';
import { EngineRegistry } from './engine/registry.js';
import type { StoredHttpApplicationOptions } from './stored-http-application.js';
import { uncoveredClientApiRoutes } from './http-client-route-coverage.test-support.js';
import { PageHosting } from './page-hosting/service.js';
import { HOSTING_SCHEMA_SQL } from './page-hosting/contract.js';
import path from 'node:path';

test('Native HTTP composition mounts domain routes with one store, current login, API token and readiness gates',async()=>{
  // Set a synthetic process-local token before importing the security module; no real token is inspected.
  process.env.RELAY_ACCESS_TOKEN='synthetic-native-http';
  const {createStoredHttpApplication}=await import('./stored-http-application.js');
  const {createPublicNewsRouter}=await import('./routes/news-public.js');
  const {createNewsAdminRouter}=await import('./routes/news-admin.js');
  const {createNewsPreferencesRouter}=await import('./routes/news-preferences.js');
  const f=fixture(),projectId=randomUUID(),token='synthetic-http-user',tokenHash=hashSessionToken(token);
  f.mutate(HOSTING_SCHEMA_SQL);
  f.mutate("UPDATE projects SET owner_user_id='other';UPDATE sessions SET owner_user_id='other'");
  f.mutate(`INSERT INTO projects(id,owner_user_id,path,name) VALUES('${projectId}','owner','D:/synthetic-http','HTTP');INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${tokenHash}','owner',${Date.now()+600000})`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const hosting=new PageHosting({port,root:path.join(f.directory,'page-hosting'),storeId:'store',generation:1,assertExclusiveWriter:async()=>{}});
  const graph=new StoredRuntimeGraph({port,storeId:'store',generation:1,registry:new EngineRegistry([]),assertExclusiveWriter:async()=>{},collectFileChanges:async()=>({}),attachmentAvailability:()=>false,resolveResource:()=>null,diagnostic:()=>{}});
  const unused=new Proxy({},{get:()=>()=>{throw Error('unrequested external service');}});
  let ready=true;
  const options={port,storeId:'store',generation:1,graph,ready:()=>ready,auth:{workspacePath:'D:/synthetic-http'},reads:{refreshSessionArchiveState:async()=>{}},
    writes:{prepareProject:async(value:string)=>value,initializeProjectFiles:async()=>{},getCatalog:async()=>({models:[]}),isEngineAvailable:()=>true,assertNotDeleting:()=>{},changed:async()=>{},softDelete:unused},
    uploads:{service:unused},uploadReads:{service:unused},draftCleanup:{service:unused},archivedCleanup:{service:unused},downloads:{service:unused},themeAssets:{service:unused},
    unarchive:{service:unused,assertNotDeleting:()=>{}},fork:{service:unused,assertNotDeleting:()=>{}},shares:{service:unused},publicShares:{getClientId:()=> 'synthetic-http-client'},
    trash:{service:unused,purge:unused},repair:{service:unused},workspace:{service:unused,snapshots:unused},accountResources:{snapshots:unused,localUsage:unused},concurrency:{resources:[],changed:async()=>{}},
    system:{version:unused,engines:unused,resources:unused,models:{getAvailability:async()=>({available:true}),getCatalog:async()=>({engineId:'codex',fetchedAt:1,stale:false,models:[]})},recovery:unused,maintenance:unused},filesystem:{service:unused},chinaDay:{cache:{calendar:unused,weather:unused}}} as unknown as StoredHttpApplicationOptions;
  options.news={service:unused as unknown as StoredHttpApplicationOptions['news']['service']};
  options.hosting=hosting;
  options.chinaDay.build=(async()=>({date:'2026-11-11'})) as any;
  options.chinaDay.cache={calendar:async()=>({value:{year:2026,month:11,days:[],warnings:[]},fetchedAt:1}),weather:async()=>({value:{date:'2026-11-11',location:{city:'测试城市'},days:[],source:'open-meteo'},fetchedAt:1})} as any;
  const service=createStoredHttpApplication(options),headers={'x-relay-token':'synthetic-native-http',cookie:`relay_session=${token}`};
  try{
    assert.equal((await service.app.request('/api/health')).status,200);
    assert.equal((await service.app.request('/api/projects')).status,401);
    assert.equal((await service.app.request('/api/projects',{headers:{'x-relay-token':'synthetic-native-http'}})).status,401);
    assert.equal((await service.app.request('/api/admin/page-hosting',{headers})).status,403);
    assert.equal((await service.app.request('/api/auth/logout',{method:'POST',headers:{...headers,origin:'null'}})).status,403,'sandboxed scripts must be rejected before any API side effects');
    const adminToken='synthetic-hosting-admin',adminHash=hashSessionToken(adminToken);
    f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${adminHash}','admin',${Date.now()+600000})`);
    const adminHeaders={'x-relay-token':'synthetic-native-http',cookie:`relay_session=${adminToken}`};
    const staged=await service.app.request('/api/admin/page-hosting/uploads',{method:'POST',headers:{...adminHeaders,'x-file-name':'index.html'},body:'<h1>Public hosted HTML</h1>'});
    assert.equal(staged.status,200);const upload=await staged.json() as any;
    const published=await service.app.request('/api/admin/page-hosting/publish',{method:'POST',headers:{...adminHeaders,'content-type':'application/json'},body:JSON.stringify({uploadId:upload.uploadId,name:'Hosted',entry:'index.html'})});
    assert.equal(published.status,200);const hosted=(await published.json() as any).site;
    for(const cookie of [undefined,`relay_session=${token}`]){
      const publicFile=await service.app.request(`/p/${hosted.id}/index.html`,{headers:{origin:'null',...(cookie?{cookie}:{})}});
      assert.equal(publicFile.status,200);assert.match(await publicFile.text(),/Public hosted HTML/);
      assert.equal(publicFile.headers.get('access-control-allow-origin'),'*');assert.equal(publicFile.headers.get('access-control-allow-credentials'),null);
    }
    for(const path of ['/api/public/tools/china-day','/api/public/tools/china-day/calendar?year=2026&month=11','/api/public/tools/china-day/weather']){
      const response=await service.app.request(path,{headers:{'x-relay-token':'synthetic-native-http'}});
      assert.equal(response.status,200,path);assert.equal(response.headers.get('cache-control'),'private, no-store');
    }
    assert.equal((await service.app.request('/api/auth/tools-settings',{headers:{'x-relay-token':'synthetic-native-http'}})).status,401);
    const projects=await service.app.request('/api/projects',{headers});assert.equal(projects.status,200);assert.equal(projects.headers.get('x-frame-options'),'DENY');
    assert.ok((await projects.json() as any[]).some(project=>project.id===projectId));
    assert.equal((await service.app.request('/api/engine-concurrency',{headers})).status,200);
    assert.equal((await service.app.request('/api/system/engines/codex/models?refresh=1',{headers})).status,200);
    assert.equal((await service.app.request('/api/system/codex-account',{headers})).status,403);
    const created=await service.app.request('/api/sessions',{method:'POST',headers:{...headers,'content-type':'application/json','x-relay-operation-id':randomUUID()},body:JSON.stringify({projectId,title:'Fixed native title'})});
    assert.equal(created.status,201);const session=await created.json() as any;
    assert.equal(session.title,'Fixed native title');assert.equal(f.scalar(`SELECT title_manually_set FROM sessions WHERE id='${session.id}'`),1);
    const ordering=await service.app.request('/api/sidebar-order',{headers});assert.equal(ordering.status,200);
    const moveKey=randomUUID(),move={scope:`project:${projectId}`,item:{type:'session',id:session.id},before:null};
    const moveRequest=()=>service.app.request('/api/sidebar-order/move',{method:'POST',headers:{...headers,'content-type':'application/json','x-relay-operation-id':moveKey},body:JSON.stringify(move)});
    const moved=await moveRequest();assert.equal(moved.status,200);assert.equal((await moved.json() as any).order.custom,true);
    assert.equal((await moveRequest()).status,200);
    assert.equal(f.scalar(`SELECT COUNT(*) FROM sidebar_order_items WHERE scope='user:owner:project:${projectId}'`),1);
    assert.equal((await service.app.request('/api/missing-native-route',{headers})).status,404);
    const routes=new Set(service.app.routes.map(route=>route.path));
    for(const path of ['/api/projects/:id/uploads','/api/auth/theme-assets/:assetId/:variant','/api/sessions/:id/unarchive','/api/sessions/:id/fork','/api/system/message-repair/:action','/api/admin/workspace-console/dashboard','/api/system/codex-account','/api/public/shares/:token'])assert.ok(routes.has(path),path);
    // News delegates to a Worker; inspect its real subrouters instead of accepting a wildcard as coverage.
    const mounted=[...service.app.routes];
    const newsRoutes=[['/api/public/news',createPublicNewsRouter({repository:()=>null})],
      ['/api/admin/news',createNewsAdminRouter({repository:()=>null,getActor:()=>{throw Error('not requested');}})],
      ['/api/news',createNewsPreferencesRouter({repository:()=>null,getActor:()=>{throw Error('not requested');}})]] as const;
    for(const [prefix,router] of newsRoutes)mounted.push(...router.routes.map(route=>({...route,path:prefix+(route.path==='/'?'':route.path)})));
    assert.deepEqual(uncoveredClientApiRoutes(mounted),[],'Every client API URL must reach a concrete Native or News Worker route');
    ready=false;assert.equal((await service.app.request('/api/health')).status,503);assert.equal((await service.app.request('/api/projects',{headers})).status,503);
  }finally{await service.dispose();await hosting.close();await graph.close();await port.close();f.cleanup();}
});
