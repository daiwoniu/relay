import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { fixture } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import type { CoreStoragePort,StorageCommandEnvelope } from './contracts.js';
import { createStoredAuthModule } from '../routes/stored-auth.js';
import { hashSessionToken } from '../auth/session.js';
import { StoredFrontendHub } from '../ws/stored-frontend-hub.js';
import type { FrontendClient } from '../ws/frontend-client-hub.js';

const token=(id:string)=>`synthetic-notification-${id}`;
const principal=(id='owner')=>({kind:'user' as const,userId:id,authSessionHash:hashSessionToken(token(id))});
async function prepared(){
  const f=fixture();f.mutate(`CREATE TABLE user_notification_preferences(
    user_id TEXT PRIMARY KEY REFERENCES users(id),desktop_system_enabled INTEGER NOT NULL DEFAULT 0,desktop_sound_enabled INTEGER NOT NULL DEFAULT 0,
    desktop_session_end_system_enabled INTEGER NOT NULL DEFAULT 0,desktop_session_end_sound_enabled INTEGER NOT NULL DEFAULT 0,
    mobile_system_enabled INTEGER NOT NULL DEFAULT 0,mobile_sound_enabled INTEGER NOT NULL DEFAULT 0,
    mobile_session_end_system_enabled INTEGER NOT NULL DEFAULT 0,mobile_session_end_sound_enabled INTEGER NOT NULL DEFAULT 0,
    approval_sound TEXT NOT NULL DEFAULT 'gentle_dual',session_end_sound TEXT NOT NULL DEFAULT 'crisp',desktop_sound_volume INTEGER NOT NULL DEFAULT 45,
    mobile_sound_volume INTEGER NOT NULL DEFAULT 80,updated_at INTEGER NOT NULL)`);
  for(const id of ['owner','other','admin'])f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${principal(id).authSessionHash}','${id}',${Date.now()+600000})`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'notifications',generation:1,initialize:true}),hub=new StoredFrontendHub(port);
  const request=(changes:unknown,key:string=randomUUID(),id='owner'):StorageCommandEnvelope=>({protocolVersion:1,storeId:'notifications',workerGeneration:1,requestId:randomUUID(),operationId:key,
    principal:principal(id),command:{name:'account.setNotifications',input:{changes}} as any});
  const read=(id='owner')=>port.readNotificationPreferences({principal:principal(id)});
  const proxy=(overrides:Partial<CoreStoragePort>)=>new Proxy(port,{get(target,key){const value=Reflect.get(overrides,key)??Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as typeof port;
  const publish=async(userId:string)=>hub.broadcastNotificationPreferences(userId,p=>port.readNotificationPreferences({principal:p}));
  const app=(overrides:Partial<Parameters<typeof createStoredAuthModule>[0]>={})=>new Hono().route('/api/auth',createStoredAuthModule({port,storeId:'notifications',generation:1,workspacePath:'D:/synthetic-notifications',recheckUserAccess:()=>{},notificationPreferencesChanged:publish,...overrides}).router);
  const send=(server:Hono,changes?:unknown,key:string=randomUUID(),id='owner',extra:Record<string,string>={})=>server.request('/api/auth/notification-preferences',{
    method:changes===undefined?'GET':'PATCH',headers:{cookie:`relay_session=${token(id)}`,'content-type':'application/json','x-relay-operation-id':key,...extra},...(changes===undefined?{}:{body:JSON.stringify(changes)})});
  const client=async(id='owner')=>{const auth=(await port.authenticateSession({tokenHash:principal(id).authSessionHash}))!,messages:any[]=[];
    const ws={readyState:1,bufferedAmount:0,send(data:string,callback:(error?:Error)=>void){messages.push(JSON.parse(data));callback();},close(){this.readyState=3;}};
    const c:FrontendClient={ws:ws as any,ip:'127.0.0.1',userId:id,user:auth.user,actor:{userId:id,role:auth.user.role},authTokenHash:principal(id).authSessionHash,authExpiresAt:auth.expiresAt,authExpiryTimer:null,
      activeSubscriptionSessionId:null,subscribedSessionIds:new Set()};await hub.add(c);return{c,messages};
  };
  return{f,port,hub,request,read,proxy,app,send,publish,client,cleanup:async()=>{hub.dispose();await port.close();f.cleanup();}};
}

test('notification defaults and partial patches remain own-account, atomic and merge current values',async()=>{
  const p=await prepared();try{
    const defaults=await p.read();assert.equal(defaults.desktopSoundVolume,45);assert.equal(defaults.mobileSoundVolume,80);assert.equal(defaults.desktopSystemEnabled,false);
    const first=p.request({desktopSystemEnabled:true});assert.equal((await p.port.execute(first)).state,'committed');
    assert.equal((await p.port.execute(p.request({mobileSoundVolume:95}))).state,'committed');const current=await p.read();assert.equal(current.desktopSystemEnabled,true);assert.equal(current.mobileSoundVolume,95);
    assert.deepEqual(await p.read('other'),defaults);assert.deepEqual(await p.read('admin'),defaults);
    assert.equal((await p.port.execute(first)).state,'committed');assert.equal((await p.read()).mobileSoundVolume,95);
    const encoded=p.f.scalar(`SELECT result_json FROM _relay_storage_operations WHERE operation_id='${first.operationId}'`);
    assert.deepEqual(JSON.parse(String(encoded)),{userId:'owner'});
  }finally{await p.cleanup();}
});
test('notification whitelist rejects empty, spoofed account scope, unknown tones, bad volumes and system writes',async()=>{
  const p=await prepared();try{
    for(const value of [{},{userId:'other',desktopSystemEnabled:true},{desktopSystemEnabled:'yes'},{approvalSound:'uploaded'},{desktopSoundVolume:47},{mobileSoundVolume:105}])
      await assert.rejects(p.port.execute(p.request(value)),{code:'INVALID_ARGUMENT'});
    const system=p.request({desktopSystemEnabled:true});system.principal={kind:'system',purpose:'maintenance'};await assert.rejects(p.port.execute(system),{code:'FORBIDDEN'});
    await assert.rejects(p.port.readNotificationPreferences({principal:principal(),userId:'other'} as any),{code:'INVALID_ARGUMENT'});
    assert.equal(p.f.scalar('SELECT count(*) FROM user_notification_preferences'),0);
  }finally{await p.cleanup();}
});
test('receipt failure rolls notification write back and the same exact command may retry',async()=>{
  const p=await prepared();try{const request=p.request({desktopSystemEnabled:true});
    p.f.mutate("CREATE TRIGGER notification_receipt_failure BEFORE INSERT ON _relay_storage_operations BEGIN SELECT RAISE(ABORT,'synthetic receipt failure');END");
    assert.equal((await p.port.execute(request)).state,'unknown');assert.equal((await p.read()).desktopSystemEnabled,false);assert.equal(p.f.scalar('SELECT count(*) FROM user_notification_preferences'),0);
    p.f.mutate('DROP TRIGGER notification_receipt_failure');assert.equal((await p.port.execute(request)).state,'committed');assert.equal((await p.read()).desktopSystemEnabled,true);
  }finally{await p.cleanup();}
});
test('current disabled and forced-password logins cannot read, replay or lookup preference writes',async()=>{
  const p=await prepared();try{const request=p.request({desktopSoundEnabled:true});await p.port.execute(request);
    for(const sql of ["UPDATE users SET disabled_at=1 WHERE id='owner'","UPDATE users SET disabled_at=NULL,must_change_password=1 WHERE id='owner'"]){p.f.mutate(sql);
      await assert.rejects(p.read(),{code:'FORBIDDEN'});assert.equal((await p.port.execute(request)).state,'rejected');await assert.rejects(p.port.lookup({storeId:'notifications',operationId:request.operationId,principal:principal()}),{code:'FORBIDDEN'});
    }
  }finally{await p.cleanup();}
});
test('notification HTTP retains exact operation identity and responds with current projection on old retries',async()=>{
  const p=await prepared();try{const app=p.app(),key=randomUUID();
    const initial=await p.send(app);assert.equal(initial.status,200);assert.equal(initial.headers.get('cache-control'),'private, no-store');
    assert.equal((await p.send(app,{desktopSoundEnabled:true},key)).status,200);assert.equal((await p.send(app,{mobileSoundVolume:90})).status,200);
    const replay=await p.send(app,{desktopSoundEnabled:true},key);assert.equal(replay.status,200);assert.equal((await replay.json() as any).preferences.mobileSoundVolume,90);
    assert.equal((await p.send(app,{desktopSoundEnabled:false},key)).status,409);assert.equal((await p.send(app,{},randomUUID())).status,400);
    const text=await (await p.send(app)).text();assert.ok(!text.includes('userId'));assert.ok(!text.includes('authSessionHash'));
  }finally{await p.cleanup();}
});
test('notification HTTP authenticates and checks Origin and strict input before saving',async()=>{
  const p=await prepared();try{const app=p.app();
    assert.equal((await app.request('/api/auth/notification-preferences')).status,401);
    assert.equal((await p.send(app,{desktopSystemEnabled:true},randomUUID(),'owner',{origin:'https://hostile.invalid'})).status,403);
    assert.equal((await p.send(app,{desktopSystemEnabled:true},'bad')).status,400);
    assert.equal((await p.send(app,{userId:'other',desktopSystemEnabled:true})).status,400);
    assert.equal((await p.send(app,{approvalSound:'x'.repeat(5000)})).status,413);
    p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");assert.equal((await p.send(app)).status,401);assert.equal(p.f.scalar('SELECT count(*) FROM user_notification_preferences'),0);
  }finally{await p.cleanup();}
});
test('two owner devices receive current preferences while other users and admin do not',async()=>{
  const p=await prepared();try{const one=await p.client(),two=await p.client(),other=await p.client('other'),admin=await p.client('admin');
    assert.equal((await p.send(p.app(),{approvalSound:'soft_chime'})).status,200);
    for(const c of [one,two]){assert.equal(c.messages.length,1);assert.equal(c.messages[0].type,'notification_preferences_updated');assert.equal(c.messages[0].preferences.approvalSound,'soft_chime');}
    assert.deepEqual(other.messages,[]);assert.deepEqual(admin.messages,[]);
  }finally{await p.cleanup();}
});
test('notification publisher rechecks login after loading and refuses revoked data',async()=>{
  const p=await prepared();try{const c=await p.client();await p.hub.broadcastNotificationPreferences('owner',async principal=>{
    const value=await p.port.readNotificationPreferences({principal});p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");return value;});
    assert.deepEqual(c.messages,[]);assert.equal(c.c.ws.readyState,3);
  }finally{await p.cleanup();}
});
test('lost notification reply resolves exact receipt; unknown lookup never publishes a success',async()=>{
  for(const available of [true,false]){const p=await prepared();try{let publishes=0;
    const port=p.proxy({execute:async(request:any)=>{await p.port.execute(request);return{state:'unknown',operationId:request.operationId,cause:'transport',recovery:'lookup'};},
      ...(!available?{lookup:async()=>{throw new Error('private failed lookup');}}:{})} as any);
    const result=await p.send(p.app({port,notificationPreferencesChanged:()=>{publishes++;}}),{desktopSystemEnabled:true});assert.equal(result.status,available?200:503);assert.equal(publishes,Number(available));assert.equal((await p.read()).desktopSystemEnabled,true);
  }finally{await p.cleanup();}}
});
test('notification publication failure leaves committed preferences available for GET',async()=>{
  const p=await prepared();try{const app=p.app({notificationPreferencesChanged:()=>{throw new Error('private push failure');}});
    assert.equal((await p.send(app,{desktopSoundVolume:60})).status,200);assert.equal((await (await p.send(app)).json() as any).preferences.desktopSoundVolume,60);
  }finally{await p.cleanup();}
});
