import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import {
  ANALYTICS_SCHEMA_SQL,AnalyticsBatchSchema,AnalyticsClientEventSchema,AnalyticsEventSchema,
  AnalyticsRecordSchema,type AnalyticsRecord,
} from './contract.js';
import { ANALYTICS_REGISTRY,ANALYTICS_FEATURES,analyticsPropertiesBytes } from './registry.js';
import { ANALYTICS_COVERAGE,ANALYTICS_EXISTING_COVERAGE,ANALYTICS_OBSERVATION_LIMITS,ANALYTICS_IMPLEMENTATION_EVIDENCE } from './coverage.js';
import { analyticsMeaning } from './semantics.js';
import { AnalyticsService } from './service.js';
import { createAnalyticsRouter } from './routes.js';
import { appendAnalytics } from '../storage/native-analytics.js';
import { nativeQueries } from '../storage/native-queries.js';

function event(name: string, properties: unknown) {
  return {id:randomUUID(),page:'chat',pageViewId:randomUUID(),referrerHost:null,device:'desktop',browser:'Chrome',os:'Windows',name,properties};
}
function props(feature='settings',action='open',extra:Record<string,unknown>={}) {
  return {feature,action,surface:'unknown',...extra};
}

test('登记表每个语义主点唯一、覆盖矩阵没有伪装已接入且源码位置存在',()=>{
  assert.equal(new Set(ANALYTICS_REGISTRY.map(entry=>entry.id)).size,ANALYTICS_REGISTRY.length);
  assert.equal(new Set(ANALYTICS_REGISTRY.map(entry=>`${entry.name}:${entry.feature}:${entry.action}`)).size,ANALYTICS_REGISTRY.length);
  const covered=ANALYTICS_COVERAGE.flatMap(group=>group.registrations.map(entry=>entry.id));
  assert.deepEqual(new Set(covered),new Set(ANALYTICS_REGISTRY.map(entry=>entry.id)));
  assert.equal(covered.length,ANALYTICS_REGISTRY.length);
  assert.ok(ANALYTICS_COVERAGE.every(group=>group.registrations.length>0&&group.registrations.every(entry=>entry.status==='planned'||entry.status==='retired'||entry.source)));
  assert.deepEqual(ANALYTICS_COVERAGE.flatMap(group=>group.registrations.filter(entry=>entry.status==='retired').map(entry=>entry.id)).sort(), ['maintenance.apply_repair','maintenance.preview_repair']);
  assert.equal(ANALYTICS_COVERAGE.flatMap(group=>group.registrations).find(entry=>entry.id==='maintenance.apply_repair.result')?.status,'implemented');
  for(const item of ANALYTICS_IMPLEMENTATION_EVIDENCE){
    assert.ok(existsSync(new URL(`../../../${item.source}`,import.meta.url)),item.source);
    for(const id of item.ids)assert.ok(ANALYTICS_REGISTRY.some(entry=>entry.id===id),id);
  }
  assert.deepEqual(new Set(ANALYTICS_COVERAGE.flatMap(group=>group.features)),new Set(Object.keys(ANALYTICS_FEATURES)));
  for(const file of [...ANALYTICS_COVERAGE.flatMap(group=>group.sources),...ANALYTICS_EXISTING_COVERAGE.map(entry=>entry.source)]) {
    assert.ok(existsSync(new URL(`../../../${file}`,import.meta.url)),file);
  }
  assert.equal(ANALYTICS_EXISTING_COVERAGE.length,6);
  assert.ok(ANALYTICS_OBSERVATION_LIMITS.some(entry=>entry.id==='download_saved'&&entry.status==='unobservable'));
});

test('所有登记条目可被对应采集端解析，不能从客户端冒充服务器结果',()=>{
  for(const entry of ANALYTICS_REGISTRY){
    const p=props(entry.feature,entry.action,{
      ...(entry.outcome==='required'?{result:entry.results[0]}:{}),
      ...(entry.correlated?{operationId:randomUUID()}:{}),
      ...(entry.toolIds?{toolId:entry.toolIds[0]}:{}),
    });
    const e=event(entry.name,p);
    assert.equal(AnalyticsEventSchema.safeParse(e).success,true,entry.id);
    assert.equal(AnalyticsClientEventSchema.safeParse(e).success,entry.producer==='client',entry.id);
    const meaning=analyticsMeaning(AnalyticsEventSchema.parse(e));
    assert.equal(meaning.registrationId,entry.id);
    assert.equal(meaning.metric,entry.metric);
    assert.match(entry.label,/[\u4e00-\u9fff]/);
  }
});

test('功能访问与意图无成功默认值，本地操作结果只接受显式登记属性',()=>{
  assert.ok(AnalyticsClientEventSchema.safeParse(event('feature_view',props())).success);
  assert.equal(AnalyticsClientEventSchema.safeParse(event('feature_view',props('settings','open',{result:'success'}))).success,false);
  const copy=event('feature_action',props('file_preview','copy_path',{result:'success'}));
  assert.ok(AnalyticsClientEventSchema.safeParse(copy).success);
  for(const extra of [
    {result:undefined},{operationId:randomUUID()},{durationMs:-1},{durationMs:86_400_001},
    {filePath:'D:/PRIVATE_SENTINEL/file.txt'},{url:'https://example.com/?token=PRIVATE_SENTINEL'},
    {error:{message:'PRIVATE_SENTINEL'}},{mode:'D:/PRIVATE_SENTINEL'},
    {reasonCode:'PRIVATE_SENTINEL'},{surface:'PRIVATE_SENTINEL'},
  ]) assert.equal(AnalyticsClientEventSchema.safeParse({...copy,properties:{...copy.properties as object,...extra}}).success,false,JSON.stringify(extra));
  assert.equal(AnalyticsClientEventSchema.safeParse(event('feature_action',props('tools','copy',{result:'success'}))).success,false,'旧工具复制不得注册等价双写');
  assert.equal(AnalyticsClientEventSchema.safeParse(event('feature_view',props('settings','open',{surface:'paste'}))).success,false);
  assert.equal(AnalyticsClientEventSchema.safeParse(event('feature_view',props('settings','open',{settingKey:'password'}))).success,false,'属性属于其它登记项时拒绝');
  assert.equal(AnalyticsClientEventSchema.safeParse(event('feature_view',props('__proto__'))).success,false);
  assert.equal(AnalyticsClientEventSchema.safeParse(event('feature_action',props('tools','pause'))).success,false);
  assert.equal(AnalyticsClientEventSchema.safeParse(event('feature_action',props('tools','pause',{toolId:'json'}))).success,false);
  const pause=AnalyticsEventSchema.parse(event('feature_action',props('tools','pause',{toolId:'pomodoro'})));
  assert.equal(analyticsMeaning(pause).feature,'tool.pomodoro');
});

test('远端意图、受理与回合结果保持不同的分母及可信采集边界',()=>{
  const operationId=randomUUID();
  const intent=event('feature_action',props('composer','submit',{operationId,surface:'keyboard',countBucket:'1'}));
  assert.ok(AnalyticsClientEventSchema.safeParse(intent).success);
  assert.equal(AnalyticsClientEventSchema.safeParse({...intent,properties:{...intent.properties as object,result:'success'}}).success,false);
  assert.equal(AnalyticsClientEventSchema.safeParse({...intent,properties:{...intent.properties as object,queued:true}}).success,false,'排队状态必须由服务端结果确认');
  assert.equal(AnalyticsClientEventSchema.safeParse(event('feature_action',props('composer','submit'))).success,false);
  const accepted=event('operation_result',props('composer','submit',{operationId,result:'success',queued:true}));
  const completed=event('operation_result',props('conversation','run',{operationId,result:'error',reasonCode:'EMPTY_FINAL',queueWaitMs:12,firstOutputMs:0}));
  assert.ok(AnalyticsEventSchema.safeParse(accepted).success);
  assert.ok(AnalyticsEventSchema.safeParse(completed).success);
  assert.equal(AnalyticsClientEventSchema.safeParse(accepted).success,false);
  assert.equal(AnalyticsClientEventSchema.safeParse(completed).success,false);
  const meanings=[intent,accepted,completed].map(e=>analyticsMeaning(AnalyticsEventSchema.parse(e)));
  assert.deepEqual(meanings.map(m=>m.metric),['action','result','result']);
  assert.notEqual(meanings[1].registrationId,meanings[2].registrationId);
  assert.ok(meanings.every(m=>m.operationId===operationId));
  const localLoad=event('operation_result',props('file_preview','load',{operationId,result:'error',reasonCode:'LOAD_FAILED'}));
  assert.ok(AnalyticsClientEventSchema.safeParse(localLoad).success);
  assert.equal(AnalyticsClientEventSchema.safeParse({...localLoad,clientSource:'gateway'}).success,false);
  assert.ok(AnalyticsEventSchema.safeParse({...completed,clientSource:'gateway',clientVersion:'0.55.0'}).success);
  assert.equal(AnalyticsClientEventSchema.safeParse(event('operation_result',props('file_preview','media_error',{operationId,result:'success'}))).success,false);
  assert.equal(AnalyticsClientEventSchema.safeParse(event('operation_result',props('connection','page_error',{operationId,result:'success'}))).success,false);
  assert.equal(AnalyticsEventSchema.safeParse({...accepted,properties:{...accepted.properties as object,reasonCode:'OPERATION_FAILED'}}).success,false);
});

test('六类历史事件原样兼容，读取语义投影不产生新事件或虚构缺失结果',()=>{
  const rows=[
    event('page_view',{}),event('tool_open',{toolId:'json'}),
    event('tool_action',{toolId:'json',action:'copy',result:'success'}),
    event('news_click',{newsId:'news-1'}),event('login_result',{}),event('hosting_document',{siteId:'site-1'}),
  ];
  const events=rows.map(row=>AnalyticsEventSchema.parse(row));
  assert.deepEqual(events,rows);
  assert.deepEqual(events.map(row=>analyticsMeaning(row).metric),['page','view','action','action','result','hosting']);
  assert.equal(analyticsMeaning(events[4]).result,null);
  assert.equal(analyticsMeaning({...events[0],page:'analytics_admin'}).analyticsSelf,true);
  const adminAction=AnalyticsEventSchema.parse(event('feature_action',props('analytics','refresh')));
  assert.equal(analyticsMeaning(adminAction).analyticsSelf,true);
  const recover=AnalyticsEventSchema.parse(event('operation_result',props('connection','recover',{operationId:randomUUID(),result:'success',trigger:'automatic'})));
  assert.equal(analyticsMeaning(recover).automatic,true);
  assert.equal(analyticsMeaning(recover).metric,'system');
  const timer=AnalyticsEventSchema.parse(event('tool_action',{toolId:'pomodoro',action:'complete',result:'success'}));
  assert.equal(analyticsMeaning(timer).automatic,true,'既有番茄钟自动完成不应冒充用户明确操作');
  assert.ok(AnalyticsBatchSchema.safeParse({events:rows.slice(0,4)}).success);
});

test('UTF-8计量按字节，扩展事件不改变批次/来源/身份严格边界',()=>{
  assert.equal(analyticsPropertiesBytes({x:'a'.repeat(504)}),512);
  assert.equal(analyticsPropertiesBytes({x:'中'.repeat(168)}),512);
  assert.equal(analyticsPropertiesBytes({x:'中'.repeat(169)}),515);
  const e=event('feature_view',props());
  assert.equal(AnalyticsBatchSchema.safeParse({events:Array(21).fill(e)}).success,false);
  assert.equal(AnalyticsClientEventSchema.safeParse({...e,userId:'admin'}).success,false);
  assert.equal(AnalyticsClientEventSchema.safeParse({...e,sourceType:'external'}).success,false);
  assert.equal(AnalyticsClientEventSchema.safeParse({...e,networkType:'internal'}).success,false);
});

test('真实采集路由接收新版客户端事件，拒绝混批伪造服务端结果且不部分写入',async()=>{
  const rows:AnalyticsRecord[]=[];
  const port={appendAnalytics:async({records}:{records:AnalyticsRecord[]})=>{rows.push(...records);return{accepted:records.length};},authenticateSession:async()=>null};
  const service=new AnalyticsService(port);
  const app=new Hono().route('/',createAnalyticsRouter({port:port as never,service}));
  const send=(events:unknown[])=>app.request('http://localhost/api/public/analytics/events',{
    method:'POST',headers:{origin:'http://localhost'},body:JSON.stringify({events}),
  });
  try{
    const legitimate=event('feature_view',props('settings','open',{surface:'user_menu'}));
    assert.equal((await send([legitimate])).status,204);
    const forged=event('operation_result',props('conversation','run',{operationId:randomUUID(),result:'success'}));
    assert.equal((await send([legitimate,forged])).status,400);
    assert.equal(service.quality().validationRejected,1);
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(rows.length,1);
    assert.equal(rows[0].event.name,'feature_view');
    assert.equal(rows[0].role,'guest');
    assert.equal(rows[0].userId,null);
  }finally{await service.close();}
});

test('现有SQLite写入接受旧新混合与服务端结果，重复ID不增加记录且不覆盖终态',()=>{
  const db=new DatabaseSync(':memory:');db.exec(ANALYTICS_SCHEMA_SQL);
  try{
    const now=Date.now(),operationId=randomUUID();
    const events=[
      event('tool_action',{toolId:'json',action:'format',result:'success'}),
      event('feature_view',props()),
      event('operation_result',props('conversation','run',{operationId,result:'success',durationMs:25})),
    ];
    const records=events.map(e=>AnalyticsRecordSchema.parse({event:e,receivedAt:now,visitorId:null,userId:'actor-1',role:'member',ip:null,version:'0.55.0'}));
    assert.deepEqual(appendAnalytics(nativeQueries(db),records,now),{accepted:3});
    assert.deepEqual(appendAnalytics(nativeQueries(db),records,now),{accepted:0});
    const changed={...records[2],event:{...records[2].event,properties:{...records[2].event.properties,result:'error'}}} as AnalyticsRecord;
    appendAnalytics(nativeQueries(db),[changed],now);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM analytics_events').get()!.n,3);
    const saved=db.prepare('SELECT properties FROM analytics_events WHERE id=?').get(records[2].event.id)!;
    assert.equal(JSON.parse(saved.properties as string).result,'success');
  }finally{db.close();}
});
