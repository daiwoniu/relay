import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ANALYTICS_SCHEMA_SQL,AnalyticsQuerySchema} from './contract.js';
import {readFeatureAnalytics} from './read-features.js';
import {nativeQueries} from '../storage/native-queries.js';
import {AnalyticsReader} from './reader.js';
import {fixture} from '../storage/storage-fixture.test-support.js';
import {Hono} from 'hono';
import {StorageWorkerClient} from '../storage/worker-client.js';
import {hashSessionToken} from '../auth/session.js';
import {AnalyticsService} from './service.js';
import {createAnalyticsRouter} from './routes.js';
import {Worker} from 'node:worker_threads';
import {HOSTING_SCHEMA_SQL} from '../page-hosting/contract.js';

test('Worker仅显式请求快照时包装响应，旧Reader消息保持原格式',async()=>{
 const f=fixture(),worker=new Worker(new URL('./reader-bootstrap.mjs',import.meta.url),{workerData:{filename:f.filename}});
 try{
  const reply=await new Promise<any>((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.postMessage({view:'features',query:{range:'all',excludeAdmin:false}});});
  assert.ok(Array.isArray(reply.value.features));assert.equal(reply.value.data,undefined);
 }finally{await worker.terminate();f.cleanup();}
});

test('真实HTTP筛选和快照兼容旧响应，拒绝非法参数及非管理员',async()=>{
 const f=fixture();
 f.mutate(HOSTING_SCHEMA_SQL);
 f.mutate(`UPDATE auth_sessions SET token_hash='${hashSessionToken('ux-admin')}' WHERE user_id='admin'; UPDATE auth_sessions SET token_hash='${hashSessionToken('ux-owner')}' WHERE user_id='owner'`);
 const port=await StorageWorkerClient.open({filename:f.filename,storeId:'ux-read',generation:1,initialize:true}),reader=new AnalyticsReader(f.filename),service=new AnalyticsService(port);
 const app=new Hono().route('/',createAnalyticsRouter({port,reader,service})),headers={cookie:'relay_session=ux-admin'};
 try{
  assert.equal((await app.request('/api/admin/analytics/features')).status,401);
  assert.equal((await app.request('/api/admin/analytics/actions',{headers:{cookie:'relay_session=ux-owner'}})).status,403);
  const wrapped=await app.request('/api/admin/analytics/actions?range=all&feature=tool.qr&action=pin&metric=action&includeSystem=false&meta=true&fresh=true',{headers});
  assert.equal(wrapped.status,200);const body=await wrapped.json() as any;assert.ok(Number.isSafeInteger(body.asOf));assert.deepEqual(body.data.items,[]);
  const legacy=await app.request('/api/admin/analytics/actions?range=all',{headers});assert.deepEqual((await legacy.json() as any).items,[]);
  for(const size of [10,50,100])assert.equal((await app.request(`/api/admin/analytics/actions?pageSize=${size}`,{headers})).status,200);
  for(const size of ['1','20','1000','1e2'])assert.equal((await app.request(`/api/admin/analytics/actions?pageSize=${size}`,{headers})).status,400);
  assert.equal((await app.request('/api/admin/analytics/features?pageSize=10',{headers})).status,400);
  for(const suffix of ['includeSystem=invalid','result=anything','feature=private/path','operationId=secret','fresh=999','metric=page'])assert.equal((await app.request('/api/admin/analytics/actions?'+suffix,{headers})).status,400,suffix);
  assert.equal((await app.request('/api/admin/analytics/features?feature=settings',{headers})).status,400);
  for(const view of ['summary','features','visits','actions']){
    const href=`/api/admin/analytics/${view}`;
    assert.equal((await app.request(`${href}?range=custom&startAt=1780000000000&endAt=1780003600000`,{headers})).status,200);
    assert.equal((await app.request(`${href}?range=24h`,{headers})).status,200);
    for(const suffix of ['range=custom','range=custom&startAt=5&endAt=4','range=custom&startAt=1e3&endAt=2000','range=today&startAt=10&endAt=20'])assert.equal((await app.request(`${href}?${suffix}`,{headers})).status,400);
  }
  const quality=await app.request('/api/admin/analytics/quality?meta=true',{headers});assert.equal((await quality.json() as any).data.scope,'current_process');
 }finally{await reader.close();await service.close();await port.close();f.cleanup();}
});

test('筛选在分页前执行，隐藏系统与统计自身，安全明细不泄漏额外属性',()=>{
 const raw=new DatabaseSync(':memory:');raw.exec(ANALYTICS_SCHEMA_SQL);const db=nativeQueries(raw),now=Date.now(),operationId=randomUUID();
 const insert=(name:string,properties:object,offset=0)=>raw.prepare('INSERT INTO analytics_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),now-offset,name,'chat',null,null,null,'member',null,'0',null,'desktop','Chrome','Windows',JSON.stringify(properties));
 try{
  for(let i=0;i<120;i++)insert('feature_action',{feature:'settings',action:'close',surface:'settings'});
  for(let i=0;i<104;i++)insert('operation_result',{feature:'file_preview',action:'load',surface:'preview_content',result:'error',operationId:i===0?operationId:randomUUID(),reasonCode:'LOAD_FAILED',fileKind:'pdf',sizeBucket:'1_5mb',filePath:'PRIVATE_SENTINEL'},i+1);
  insert('feature_action',{feature:'file_preview',action:'copy_path',surface:'preview_toolbar',result:'error'},200);
  insert('feature_action',{feature:'analytics',action:'refresh',surface:'admin'},201);
  insert('tool_action',{toolId:'pomodoro',action:'complete',result:'success'},202);
  insert('feature_action',{feature:'tools',toolId:'qr',action:'pin',surface:'tools',operationId:randomUUID()},203);
  const query=AnalyticsQuerySchema.parse({range:'all',excludeAdmin:false,feature:'file_preview',result:'error',includeSystem:false});
  const first=readFeatureAnalytics(db,query,'actions',undefined,now) as any,second=readFeatureAnalytics(db,query,'actions',first.next,now) as any;
  assert.equal(first.items.length,100);assert.equal(second.items.length,5);assert.equal(second.next,null);assert.equal(new Set([...first.items,...second.items].map(row=>row.id)).size,105);
  assert.equal(first.items[0].details.reasonCode,'LOAD_FAILED');assert.doesNotMatch(JSON.stringify(first),/PRIVATE_SENTINEL|filePath/);
  assert.equal(first.items[0].details.fileKind,'pdf');assert.equal(first.items[0].details.sizeBucket,'1_5mb');
  assert.equal(first.items[0].operationRecordCount,1);
  const firstTen=readFeatureAnalytics(db,{...query,pageSize:10},'actions',undefined,now) as any;
  const nextTen=readFeatureAnalytics(db,{...query,pageSize:10},'actions',firstTen.next,now) as any;
  assert.equal(firstTen.items.length,10);assert.equal(nextTen.items.length,10);
  assert.equal(new Set([...firstTen.items,...nextTen.items].map(row=>row.id)).size,20);
  const related=readFeatureAnalytics(db,{...query,operationId},'actions',undefined,now) as any;assert.equal(related.items.length,1);
  const tools=readFeatureAnalytics(db,{range:'all',excludeAdmin:false,feature:'tool.qr',metric:'action',includeSystem:false},'actions',undefined,now) as any;assert.equal(tools.items.length,1);
  const system=readFeatureAnalytics(db,{range:'all',excludeAdmin:false,metric:'system',includeSystem:true},'actions',undefined,now) as any;assert.equal(system.items.length,100);assert.ok(system.items.every((row:{metric:string})=>row.metric==='system'));
  const systemNext=readFeatureAnalytics(db,{range:'all',excludeAdmin:false,metric:'system',includeSystem:true},'actions',system.next,now) as any;assert.equal(systemNext.items.length,21);assert.equal(systemNext.items.find((row:{action:string})=>row.action==='complete').metric,'system');
  const features=readFeatureAnalytics(db,{range:'all',excludeAdmin:false},'features',undefined,now) as any;
  const preview=features.features.find((row:{feature:string})=>row.feature==='file_preview');assert.equal(preview.failures,105);assert.equal(preview.actions,1);assert.equal(preview.results.error,104);
  assert.equal(features.messageSubmits,0);
  insert('feature_action',{feature:'composer',action:'submit',surface:'composer'});
  insert('operation_result',{feature:'composer',action:'submit',surface:'composer',result:'success'});
  const withSubmit=readFeatureAnalytics(db,{range:'all',excludeAdmin:false},'features',undefined,now) as any;
  assert.equal(withSubmit.messageSubmits,1,'仅统计提交动作，关联结果不重复记数');
  const paired=randomUUID();
  insert('feature_action',{feature:'settings',action:'save',surface:'settings',operationId:paired});
  insert('operation_result',{feature:'settings',action:'save',surface:'settings',result:'error',operationId:paired,reasonCode:'PERMISSION_DENIED'});
  const errors=readFeatureAnalytics(db,{range:'all',excludeAdmin:false,feature:'settings',result:'error',pageSize:10},'actions',undefined,now) as any;
  assert.equal(errors.items[0].operationRecordCount,2,'即使另一条是触发记录，也能从失败筛选下找到');
  const pair=readFeatureAnalytics(db,{range:'all',excludeAdmin:false,operationId:paired,includeSystem:true,pageSize:10},'actions',undefined,now) as any;
  assert.equal(pair.items.length,2);
  assert.equal(AnalyticsQuerySchema.safeParse({range:'all',feature:"';DROP TABLE analytics_events;--"}).success,false);
 }finally{raw.close();}
});

test('真实读取快照保留生成时间，手动刷新限频且不影响旧read调用',async()=>{
 const f=fixture(),reader=new AnalyticsReader(f.filename),query={range:'all' as const,excludeAdmin:false};const original=Date.now;let logical=original();Date.now=()=>logical;
 try{
  const first=await reader.readSnapshot('features',query);assert.equal(first.cached,false);
  const cached=await reader.readSnapshot('features',query,undefined,true);assert.equal(cached.cached,true);assert.equal(cached.asOf,first.asOf);
  const raw=new DatabaseSync(f.filename);raw.prepare('INSERT INTO analytics_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),original()-1,'feature_view','chat',null,null,null,'member',null,'0',null,'desktop','Chrome','Windows',JSON.stringify({feature:'settings',action:'open',surface:'settings'}));raw.close();
  logical=first.asOf+5001;
  const refreshed=await reader.readSnapshot('features',query,undefined,true);assert.equal(refreshed.cached,false);assert.equal((refreshed.data as any).features[0].views,1);
  assert.equal((await reader.read('features',query) as any).features[0].views,1);
 }finally{Date.now=original;await reader.close();f.cleanup();}
});
