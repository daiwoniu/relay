import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { fixture } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import type { StorageCommandEnvelope } from './contracts.js';
import { createDefaultThemeSettings,projectThemeSettingsV1 } from '../theme/theme-settings.js';
import { createStoredAuthModule } from '../routes/stored-auth.js';
import { hashSessionToken } from '../auth/session.js';
import { StoredFrontendHub } from '../ws/stored-frontend-hub.js';
import type { FrontendClient } from '../ws/frontend-client-hub.js';
const token=(id:string)=>`synthetic-theme-${id}`;
const principal=(id='owner')=>({kind:'user' as const,userId:id,authSessionHash:hashSessionToken(token(id))});
async function prepared(){
  const f=fixture();f.mutate(`CREATE TABLE user_theme_settings(user_id TEXT PRIMARY KEY REFERENCES users(id),settings_json TEXT NOT NULL,color_style TEXT NOT NULL DEFAULT 'neutral',text_scale TEXT NOT NULL DEFAULT 'standard',updated_at INTEGER NOT NULL);
    CREATE TABLE user_theme_assets(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL)`);
  for(const id of ['owner','other','admin'])f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${principal(id).authSessionHash}','${id}',${Date.now()+600000})`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'theme-test',generation:1,initialize:true}),hub=new StoredFrontendHub(port);
  const read=(id='owner')=>port.readThemeSettings({principal:principal(id)});
  const input=()=>({...createDefaultThemeSettings(),updatedAt:0});
  const request=(settings:unknown,key:string=randomUUID(),id='owner'):StorageCommandEnvelope=>({protocolVersion:1,storeId:'theme-test',workerGeneration:1,requestId:randomUUID(),operationId:key,principal:principal(id),command:{name:'account.setTheme',input:{settings}} as any});
  const publish=async(userId:string)=>hub.broadcastThemeSettings(userId,p=>port.readThemeSettings({principal:p}));
  const app=(overrides:Partial<Parameters<typeof createStoredAuthModule>[0]>={})=>new Hono().route('/api/auth',createStoredAuthModule({port,storeId:'theme-test',generation:1,workspacePath:'D:/synthetic-theme',recheckUserAccess:()=>{},themeSettingsChanged:publish,...overrides}).router);
  const send=(server:Hono,settings?:unknown,key:string=randomUUID(),id='owner',extra:Record<string,string>={})=>server.request('/api/auth/theme-settings',{
    method:settings===undefined?'GET':'PUT',headers:{cookie:`relay_session=${token(id)}`,'content-type':'application/json','x-relay-operation-id':key,...extra},...(settings===undefined?{}:{body:JSON.stringify(settings)})});
  const client=async(id='owner')=>{const auth=(await port.authenticateSession({tokenHash:principal(id).authSessionHash}))!,messages:any[]=[];
    const ws={readyState:1,bufferedAmount:0,send(data:string,callback:(error?:Error)=>void){messages.push(JSON.parse(data));callback();},close(){this.readyState=3;}};
    const c:FrontendClient={ws:ws as any,ip:'127.0.0.1',userId:id,user:auth.user,actor:{userId:id,role:auth.user.role},authTokenHash:principal(id).authSessionHash,authExpiresAt:auth.expiresAt,authExpiryTimer:null,activeSubscriptionSessionId:null,subscribedSessionIds:new Set()};
    await hub.add(c);return{c,messages};
  };
  return{f,port,hub,request,read,input,publish,app,send,client,cleanup:async()=>{hub.dispose();await port.close();f.cleanup();}};
}
test('theme save is own-account, uses server time, retains v1 storage and returns bounded current v2',async()=>{
  const p=await prepared();try{assert.equal((await p.read()).version,2);
    const settings={...p.input(),basePreference:'dark' as const,colorStyle:'aurora' as const,textScale:'large' as const},request=p.request(settings);
    assert.equal((await p.port.execute(request)).state,'committed');const value=await p.read();assert.equal(value.basePreference,'dark');assert.equal(value.colorStyle,'aurora');assert.equal(value.textScale,'large');assert.ok(value.updatedAt>0);
    assert.equal(JSON.parse(String(p.f.scalar("SELECT settings_json FROM user_theme_settings WHERE user_id='owner'"))).version,1);
    assert.equal((await p.read('other')).colorStyle,'neutral');assert.equal((await p.read('admin')).colorStyle,'neutral');
    assert.deepEqual(JSON.parse(String(p.f.scalar('SELECT result_json FROM _relay_storage_operations LIMIT 1'))),{userId:'owner'});
  }finally{await p.cleanup();}
});
test('v1 compatibility preserves existing color style and scale while normalizing linked profiles',async()=>{
  const p=await prepared();try{await p.port.execute(p.request({...p.input(),colorStyle:'aurora',textScale:'large'}));
    const v1=projectThemeSettingsV1({...p.input(),linkedProfiles:true,desktop:{...p.input().desktop,blur:10},mobile:{...p.input().mobile,blur:2}});
    assert.equal((await p.port.execute(p.request(v1))).state,'committed');const value=await p.read();assert.equal(value.colorStyle,'aurora');assert.equal(value.textScale,'large');assert.equal(value.mobile.blur,10);
  }finally{await p.cleanup();}
});
test('theme references require an existing own asset and retain unreferenced metadata for later journaled cleanup',async()=>{
  const p=await prepared();try{const own=randomUUID(),foreign=randomUUID();p.f.mutate(`INSERT INTO user_theme_assets VALUES('${own}','owner',1),('${foreign}','other',1)`);
    const withAsset=(id:string)=>({...p.input(),desktop:{...p.input().desktop,backgroundKind:'asset',backgroundValue:id}});
    for(const id of [foreign,randomUUID()]){const result=await p.port.execute(p.request(withAsset(id)));assert.equal(result.state,'rejected');if(result.state==='rejected')assert.equal(result.code,'NOT_FOUND');}
    assert.equal((await p.port.execute(p.request(withAsset(own)))).state,'committed');assert.equal((await p.read()).desktop.backgroundValue,own);
    assert.equal((await p.port.execute(p.request(p.input()))).state,'committed');assert.equal(p.f.scalar('SELECT count(*) FROM user_theme_assets'),2);
  }finally{await p.cleanup();}
});
test('theme receipt failure rolls settings back and exact retry is safe',async()=>{
  const p=await prepared();try{const request=p.request({...p.input(),basePreference:'dark'});
    p.f.mutate("CREATE TRIGGER theme_receipt_failure BEFORE INSERT ON _relay_storage_operations BEGIN SELECT RAISE(ABORT,'synthetic');END");
    assert.equal((await p.port.execute(request)).state,'unknown');assert.equal(p.f.scalar('SELECT count(*) FROM user_theme_settings'),0);
    p.f.mutate('DROP TRIGGER theme_receipt_failure');assert.equal((await p.port.execute(request)).state,'committed');assert.equal((await p.read()).basePreference,'dark');
  }finally{await p.cleanup();}
});
test('theme reads reject oversized stored JSON before loading it and reject cross-account input',async()=>{
  const p=await prepared();try{await assert.rejects(p.port.readThemeSettings({principal:principal(),userId:'other'} as any),{code:'INVALID_ARGUMENT'});
    p.f.mutate("INSERT INTO user_theme_settings VALUES('owner',replace(hex(zeroblob(9000)),'0','x'),'neutral','standard',1)");
    await assert.rejects(p.read(),{code:'PAYLOAD_TOO_LARGE'});assert.equal(p.f.scalar('SELECT length(settings_json) FROM user_theme_settings'),18000);
  }finally{await p.cleanup();}
});
test('theme semantic background validation rejects unknown presets and invalid none references without writing',async()=>{
  const p=await prepared();try{
    for(const desktop of [{...p.input().desktop,backgroundKind:'preset',backgroundValue:'missing-preset'},{...p.input().desktop,backgroundKind:'none',backgroundValue:'https://untrusted.invalid'}]){
      const result=await p.port.execute(p.request({...p.input(),desktop}));assert.equal(result.state,'rejected');if(result.state==='rejected')assert.equal(result.code,'INVALID_ARGUMENT');
    }
    assert.equal(p.f.scalar('SELECT count(*) FROM user_theme_settings'),0);
  }finally{await p.cleanup();}
});
test('theme HTTP uses current projections on old replay and rejects changed exact intent',async()=>{
  const p=await prepared();try{const app=p.app(),settings=p.input(),key=randomUUID();
    assert.equal((await p.send(app,settings,key)).status,200);assert.equal((await p.send(app,{...settings,textScale:'large'})).status,200);
    const replay=await p.send(app,settings,key);assert.equal(replay.status,200);assert.equal((await replay.json() as any).settings.textScale,'large');assert.equal(replay.headers.get('cache-control'),'private, no-store');
    assert.equal((await p.send(app,{...settings,basePreference:'dark'},key)).status,409);
  }finally{await p.cleanup();}
});
test('theme HTTP enforces auth, Origin, schema, body budget and private scope',async()=>{
  const p=await prepared();try{const app=p.app();assert.equal((await app.request('/api/auth/theme-settings')).status,401);
    assert.equal((await p.send(app,p.input(),randomUUID(),'owner',{origin:'https://hostile.invalid'})).status,403);
    assert.equal((await p.send(app,{...p.input(),userId:'other'})).status,400);assert.equal((await p.send(app,{...p.input(),extra:'x'.repeat(5000)})).status,413);
    assert.equal((await p.send(app,{...p.input(),desktop:{...p.input().desktop,blur:25}})).status,400);
    p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");assert.equal((await p.send(app)).status,401);
  }finally{await p.cleanup();}
});
test('theme settings broadcast current value to both owner devices and no other account',async()=>{
  const p=await prepared();try{const one=await p.client(),two=await p.client(),other=await p.client('other');const app=p.app();
    assert.equal((await p.send(app,{...p.input(),textScale:'large'})).status,200);
    for(const c of [one,two]){assert.equal(c.messages.length,1);assert.equal(c.messages[0].type,'theme_settings_updated');assert.equal(c.messages[0].settings.textScale,'large');}assert.deepEqual(other.messages,[]);
  }finally{await p.cleanup();}
});
test('theme publisher rechecks recipient login after loading; push failure retains durable settings',async()=>{
  const p=await prepared();try{const c=await p.client();await p.hub.broadcastThemeSettings('owner',async principal=>{const settings=await p.port.readThemeSettings({principal});p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");return settings;});assert.deepEqual(c.messages,[]);
    p.f.mutate("UPDATE users SET disabled_at=NULL WHERE id='owner'");const result=await p.send(p.app({themeSettingsChanged:()=>{throw new Error('private push failure');}}),{...p.input(),colorStyle:'aurora'});assert.equal(result.status,200);assert.equal((await p.read()).colorStyle,'aurora');
  }finally{await p.cleanup();}
});
