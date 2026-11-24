import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { hashSessionToken } from '../auth/session.js';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { AnalyticsService } from './service.js';
import { AnalyticsReader } from './reader.js';
import { collectCommittedAnalytics } from './command-collector.js';
import { observeStorageCommands,publishCommandObservation } from '../storage/command-observation.js';
import { commandMeaning } from './command-meaning.js';
import type { AnalyticsRecord } from './contract.js';
import {readFeatureAnalytics} from './read-features.js';
import {nativeQueries} from '../storage/native-queries.js';
import {ANALYTICS_SCHEMA_SQL, AnalyticsBatchSchema} from './contract.js';

test('飞书管理页面 ID 通过采集校验，原始路由和未登记的 ID 被拒绝',()=>{
  const event = { id:randomUUID(), name:'page_view', page:'feishu_bots', pageViewId:randomUUID(), referrerHost:null,
    device:'desktop', browser:'Chrome', os:'Windows', properties:{} };
  assert.equal(AnalyticsBatchSchema.safeParse({events:[event]}).success,true);
  for (const page of ['/admin/feishu-bots', 'unregistered_page']) {
    assert.equal(AnalyticsBatchSchema.safeParse({events:[{...event,page}]}).success,false);
  }
});

test('同名工具动作按工具分别排行，同工具累加且不叠加服务端结果',()=>{
  const db=new DatabaseSync(':memory:');db.exec(ANALYTICS_SCHEMA_SQL);
  try{
    const now=Date.now(),insert=db.prepare('INSERT INTO analytics_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for(const [name,toolId] of [['feature_action','qr'],['feature_action','qr'],['feature_action','json'],['operation_result','qr']])
      insert.run(randomUUID(),now,name,'tools',null,null,null,'member',null,'0',null,'desktop','Chrome','Windows',JSON.stringify({feature:'tools',action:'pin',surface:'tools',toolId,operationId:randomUUID(),...(name==='operation_result'?{result:'success'}:{})}));
    const result=readFeatureAnalytics(nativeQueries(db),{range:'all',excludeAdmin:false},'features',undefined,now) as any;
    assert.deepEqual(result.operations.map((row:any)=>[row.feature,row.registrationId,row.count]),[['tool.qr','tools.pin',2],['tool.json','tools.pin',1]]);
    assert.equal(result.features.find((row:any)=>row.feature==='tool.qr').results.success,1);
  }finally{db.close();}
});

test('真实提交和重放使用同一结果ID；拒绝、停止请求和敏感输入不误记完成',async()=>{
  const f=fixture(),port=await StorageWorkerClient.open({filename:f.filename,storeId:'analytics-observer',generation:1,initialize:true});
  const authHash=hashSessionToken('synthetic-owner');
  f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${authHash}','owner',${Date.now()+3600000})`);
  const rows:AnalyticsRecord[]=[];
  const service=new AnalyticsService({authenticateSession:r=>port.authenticateSession(r),appendAnalytics:async({records})=>{rows.push(...records);return{accepted:records.length};}});
  const stop=collectCommittedAnalytics(port,service);
  try{
    const request={protocolVersion:1 as const,storeId:'analytics-observer',requestId:randomUUID(),workerGeneration:1,operationId:randomUUID(),
      principal:{kind:'user' as const,userId:'owner',authSessionHash:authHash},command:{name:'account.setDisplayName' as const,input:{displayName:'sensitive-user-text'}}};
    const first=await port.execute(request);assert.equal(first.state,'committed');
    await port.execute({...request,requestId:randomUUID()});
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(rows.length,2);assert.equal(rows[0].event.id,rows[1].event.id);
    assert.equal(rows[0].userId,'owner');assert.doesNotMatch(JSON.stringify(rows),/sensitive-user-text|auth-owner/);
    assert.equal(commandMeaning({...request,command:{name:'turn.requestStop',input:{sessionId:'session',expectedAttemptId:'attempt'}}} as any,{state:'committed',value:{requested:true}} as any),null);
    assert.equal(commandMeaning(request,{state:'rejected',operationId:request.operationId,code:'FORBIDDEN'})?.action,'save');
  }finally{stop();await service.close();await port.close();f.cleanup();}
});

test('观测异常和注销不会改变业务响应',()=>{
  const port={},stop=observeStorageCommands(port,()=>{throw Error('synthetic');});
  assert.doesNotThrow(()=>publishCommandObservation(port,{} as any,{} as any));stop();
  assert.doesNotThrow(()=>publishCommandObservation(port,{} as any,{} as any));
});

test('统计突发保持一批在途与20批等待，超额丢统计且不阻塞调用方',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let calls=0;
  const service=new AnalyticsService({authenticateSession:async()=>null,appendAnalytics:async({records})=>{calls++;await gate;return{accepted:records.length};}});
  const records=():AnalyticsRecord[]=>Array.from({length:20},()=>({event:{id:randomUUID(),name:'page_view',page:'chat',pageViewId:null,referrerHost:null,device:'unknown',browser:'Other',os:'Other',properties:{}},receivedAt:Date.now(),visitorId:null,userId:null,role:'guest',ip:null,version:'0'}));
  assert.equal(service.enqueue(records()),true);
  for(let batch=0;batch<20;batch++)assert.equal(service.enqueue(records()),true);
  assert.equal(service.enqueue(records()),false);await Promise.resolve();assert.equal(calls,1);
  assert.equal(service.quality().queuedBatches,20);assert.equal(service.quality().queueDropped,20);
  const closing=service.close();release();await closing;assert.equal(service.quality().written,20);
});

test('服务端扩展开关关闭时丢弃新事件，混批仍保留旧六类',async()=>{
  const rows:AnalyticsRecord[]=[];
  const service=new AnalyticsService({authenticateSession:async()=>null,appendAnalytics:async({records})=>{rows.push(...records);return{accepted:records.length};}},true,false);
  const base={receivedAt:Date.now(),visitorId:null,userId:null,role:'guest' as const,ip:null,version:'0'};
  const envelope={id:randomUUID(),page:'chat' as const,pageViewId:null,referrerHost:null,device:'unknown' as const,browser:'Other' as const,os:'Other' as const};
  assert.equal(service.enqueue([{...base,event:{...envelope,name:'feature_view',properties:{feature:'composer',action:'open',surface:'composer'}}},
    {...base,event:{...envelope,id:randomUUID(),name:'page_view',properties:{}}}]),true);
  await Promise.resolve();await service.close();assert.deepEqual(rows.map(row=>row.event.name),['page_view']);
});

test('只读Worker使用持久化结果，区分意图/结果并按稳定游标分页',async()=>{
  const f=fixture(),reader=new AnalyticsReader(f.filename);
  try{
    const database=new DatabaseSync(f.filename),now=Date.now(),insert=database.prepare('INSERT INTO analytics_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for(let i=0;i<105;i++)insert.run(randomUUID(),now-1000,'feature_action','chat',null,null,null,'member',null,'0',null,'desktop','Chrome','Windows',JSON.stringify({feature:'composer',action:'submit',surface:'composer',operationId:randomUUID()}));
    insert.run(randomUUID(),now-1000,'operation_result','chat',null,null,'owner','member',null,'0',null,'unknown','Other','Other',JSON.stringify({feature:'composer',action:'submit',surface:'unknown',operationId:randomUUID(),result:'success'}));
    database.exec('PRAGMA foreign_keys=OFF');
    database.prepare('INSERT INTO messages(id,session_id,turn_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?)').run('submitted-by-other','session','attempt-other','user','sensitive-content',JSON.stringify({origin:{senderUserId:'other'}}),now);
    database.prepare('INSERT INTO engine_terminal_decisions(id,session_id,attempt_id,engine,outcome,reason_code,fact_id,decided_at,projected_at) VALUES(?,?,?,?,?,?,?,?,?)').run('decision-other','session','attempt-other','codex','completed','COMPLETED','synthetic-proof',now,now);
    database.close();
    const query={range:'all' as const,excludeAdmin:false};
    const summary=await reader.read('features',query) as any;
    assert.equal(summary.features[0].actions,105);assert.equal(summary.features[0].results.success,1);
    assert.equal(summary.operations[0].count,105,'服务端结果不能抬高操作排行');
    const first=await reader.read('actions',query) as any,second=await reader.read('actions',query,first.next) as any;
    assert.equal(first.items.length,100);assert.equal(second.items.length,6);assert.equal(second.next,null);
    assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,106);
    assert.equal(await reader.actor('session','unknown-decision'),null);
    assert.deepEqual(await reader.actor('session','decision-other'),{userId:'other',role:'member'},'回合归属实际提交者，不能误用会话owner');
  }finally{await reader.close();f.cleanup();}
});
