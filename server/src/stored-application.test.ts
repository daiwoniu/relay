import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fixture } from './storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from './storage/worker-client.js';
import { EngineRegistry } from './engine/registry.js';
import type { EngineAdapter,EngineConnectionOptions,EngineEvent } from './engine/adapter.js';
import { hashSessionToken } from './auth/session.js';
import type { StoredDomainDependencies } from './stored-domain-services.js';
const until=async(check:()=>boolean)=>{for(let index=0;index<500&&!check();index++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(check(),'Native application stage timed out');};
class Socket extends EventEmitter{
  readyState=1;bufferedAmount=0;messages:any[]=[];
  send(value:string,callback:(error?:Error)=>void){this.messages.push(JSON.parse(value));callback();}
  close(){this.readyState=3;this.emit('close');}
}
test('assembled Native application accepts HTTP and real WS boundaries, dispatches once, commits terminal and drains before releasing owner',async()=>{
  process.env.RELAY_STORAGE_DRIVER='native';
  process.env.RELAY_ACCESS_TOKEN='synthetic-native-application';const {createStoredApplication}=await import('./stored-application.js');
  const f=fixture(),projectId=randomUUID(),sessionToken='synthetic-native-application-user',hash=hashSessionToken(sessionToken);
  f.mutate(`DELETE FROM engine_resource_leases;DELETE FROM messages;DELETE FROM sessions;UPDATE projects SET owner_user_id='other';
    INSERT INTO projects(id,owner_user_id,path,name) VALUES('${projectId}','owner','${f.directory.replaceAll("'","''")}','Native app');
    INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${hash}','owner',${Date.now()+600000})`);
  const seed=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});await seed.close();
  const sent:string[]=[],diagnostics:string[]=[];let sequence=0;
  const registry=new EngineRegistry([{id:'codex',availability:{getCurrent:()=>({available:true})},concurrency:{resolveResource:()=>({resourceKey:'codex:default',label:'Synthetic',defaultMaxActiveTurns:1})},runtime:{connect:(options:EngineConnectionOptions)=>{
    const ready=options.onSessionReady('synthetic-thread');
    const emit=(payload:EngineEvent)=>options.onEvent({engineId:'codex',payload,meta:{source:'realtime',sequence:++sequence,observedAt:Date.now(),externalSessionId:'synthetic-thread',externalTurnId:'synthetic-turn'}});
    return{send:(content:string)=>{sent.push(content);void Promise.resolve(ready).then(()=>{emit({type:'turn_start',turnId:'synthetic-turn'});emit({type:'delta',itemId:'answer',phase:'final_answer',content:'Native answer'});emit({type:'message_complete',turnId:'synthetic-turn',content:'Native answer'});});},cancel:async()=>{},respondToInteraction:()=>{},close:()=>options.onClosed()};
  }}} as unknown as EngineAdapter]);
  const unused=new Proxy({},{get:()=>()=>{throw Error('unrequested provider operation');}});
  const catalog={engineId:'codex',fetchedAt:1,stale:false,configurationRead:true,configuredDefaults:{modelId:'synthetic',reasoningEffort:null,serviceTier:null},models:[]};
  const application=await createStoredApplication({storage:{filename:f.filename,storeId:'store',generation:2,defaultConcurrency:{'codex:default':1}},runtime:{registry,collectFileChanges:async()=>({}),attachmentAvailability:()=>false,resolveResource:()=>({label:'Synthetic',defaultMaxActiveTurns:1}),diagnostic:code=>diagnostics.push(code)},dependencies:async()=>({
    registry,themeRoot:path.join(f.directory,'theme'),repairSourceRoot:f.directory,chinaDayCacheRoot:path.join(f.directory,'china-day-cache'),newsRoot:path.join(f.directory,'news'),newsSources:[],newsInitialize:true,auth:{workspacePath:f.directory},
    system:{version:unused,engines:unused,resources:unused,models:unused,recovery:unused,maintenance:unused},publicShares:{getClientId:()=> 'synthetic-client'},
    resources:{prepareProject:async(value:string)=>value,initializeProjectFiles:async()=>{},getCatalog:async()=>catalog,isEngineAvailable:async()=>true},snapshots:unused,usage:unused,workspace:unused,threads:unused,fork:async()=>{throw Error('unexpected fork');},fetchArchivedThreadIds:async()=>[],assertAdmission:async()=>{},attachmentAvailability:()=>false,maintenanceBusy:()=>false,diagnostic:(code:string)=>diagnostics.push(code)
  } as unknown as StoredDomainDependencies)});
  const wss=new EventEmitter();application.attachFrontend(wss as any);const socket=new Socket(),headers={'x-relay-token':'synthetic-native-application',cookie:`relay_session=${sessionToken}`};
  try{
    assert.equal((await application.app.request('/api/health')).status,503);await application.activate();
    assert.equal((await application.app.request('/api/public/news/version',{headers})).status,200);
    assert.equal((await application.app.request('/api/news/preferences',{headers})).status,200);
    assert.equal((await application.app.request('/api/admin/news/stats',{headers})).status,403);
    const response=await application.app.request('/api/sessions',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({projectId,title:'Native integration',engine:'codex'})});assert.equal(response.status,201);const session=await response.json() as any;
    wss.emit('connection',socket,{headers:{cookie:headers.cookie,origin:'http://localhost:5173'},socket:{remoteAddress:'127.0.0.1'}});await until(()=>socket.messages.some(event=>event.type==='protocol_info'));
    socket.emit('message',Buffer.from(JSON.stringify({type:'subscribe',sessionId:session.id})),false);
    const command={type:'send',sessionId:session.id,messageId:randomUUID(),engine:'codex',content:'synthetic question'};
    socket.emit('message',Buffer.from(JSON.stringify(command)),false);
    await until(()=>f.scalar(`SELECT status FROM sessions WHERE id='${session.id}'`)==='completed').catch(error=>{throw new Error(JSON.stringify({status:f.scalar(`SELECT status FROM sessions WHERE id='${session.id}'`),sent:sent.length,diagnostics,errors:socket.messages.filter(value=>value.type==='error')}),{cause:error});});
    await until(()=>socket.messages.some(event=>event.type==='message_saved'&&event.message.content==='Native answer'));
    assert.equal(sent.length,1);assert.equal(f.scalar(`SELECT count(*) FROM messages WHERE session_id='${session.id}'`),2);
    socket.emit('message',Buffer.from(JSON.stringify(command)),false);await until(()=>socket.messages.some(event=>event.type==='sync_state'&&event.messages?.some((message:any)=>message.content==='Native answer')));
    assert.equal(sent.length,1);assert.deepEqual(diagnostics,[]);
  }finally{await application.close();f.cleanup();}
});
