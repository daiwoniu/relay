import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { hashSessionToken } from '../auth/session.js';
import { nativeQueries } from '../storage/native-queries.js';
import { ANALYTICS_SCHEMA_SQL,ANALYTICS_DAY,AnalyticsClientEventSchema,type AnalyticsRecord,type AnalyticsSummary } from './contract.js';
import { trustedGatewayFrontendContext,analyticsSourceRequestUrl } from './request-context.js';
import { classifyAnalyticsSource } from '../../../scripts/lib/analytics-source.mjs';
import { appendAnalytics,readAnalytics } from '../storage/native-analytics.js';
import { ANALYTICS_TOOL_IDS } from './registry.js';
import { AnalyticsService,analyticsLoginId } from './service.js';
import { createAnalyticsRouter } from './routes.js';
import { readFeatureAnalytics } from './read-features.js';
import { HOSTING_SCHEMA_SQL } from '../page-hosting/contract.js';

function record(at=Date.now()):AnalyticsRecord & {event:Extract<AnalyticsRecord['event'],{name:'page_view'}>}{return{event:{id:randomUUID(),name:'page_view',page:'tools',pageViewId:randomUUID(),referrerHost:null,device:'mobile',browser:'Safari',os:'iOS',properties:{}},receivedAt:at,visitorId:randomUUID(),userId:null,role:'guest',ip:'203.0.113.9',version:'0.0.0'};}

test('明确缺失IP不重新采用请求头，保存值与网络分类使用相同归一结果',async()=>{
  const rows:AnalyticsRecord[]=[];
  const service=new AnalyticsService({appendAnalytics:async({records})=>{rows.push(...records);return{accepted:records.length};},authenticateSession:async()=>null});
  const app=new Hono();
  app.get('/',c=>{
    const identity={visitorId:null,userId:null,role:'guest' as const};
    rows.push(service.record(record().event,identity,null,c));
    rows.push(service.record(record().event,identity,'::ffff:192.168.1.2',c));
    rows.push(service.record(record().event,identity,'local',c));
    return c.text('ok');
  });
  try{
    await app.request('http://127.0.0.1/',{headers:{'x-relay-client-address':'192.168.1.9'}},{incoming:{socket:{remoteAddress:'127.0.0.1'}}});
    assert.deepEqual(rows.map(row=>[row.ip,row.networkType]),[[null,'unknown'],['192.168.1.2','internal'],[null,'unknown']]);
  }finally{await service.close();}
});

test('网络过滤统一作用于各类统计与明细；未知历史保留，可叠加管理员，IP和分类长期保留',()=>{
  const sql=new DatabaseSync(':memory:');sql.exec(ANALYTICS_SCHEMA_SQL+HOSTING_SCHEMA_SQL);
  try{
    const db=nativeQueries(sql),now=Date.now();
    const rows:AnalyticsRecord[]=[];
    for(const networkType of ['internal','public','unknown',undefined] as const){
      const base={...record(now),...(networkType?{networkType}:{})};
      rows.push(base,
        {...base,event:{...base.event,id:randomUUID(),name:'tool_open',properties:{toolId:'json'}}},
        {...base,event:{...base.event,id:randomUUID(),name:'tool_action',properties:{toolId:'json',action:'copy',result:'success'}}},
        {...base,event:{...base.event,id:randomUUID(),name:'news_click',properties:{newsId:'news'}}},
        {...base,event:{...base.event,id:randomUUID(),name:'login_result',page:'login',properties:{result:'success'}}},
        {...base,event:{...base.event,id:randomUUID(),name:'hosting_document',page:'hosting',properties:{siteId:'site'}}});
    }
    rows.push({...record(now),role:'admin',networkType:'public'});
    appendAnalytics(db,rows,now);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM analytics_events WHERE ip IS NOT NULL')!.n,25);
    const query={range:'30d' as const,excludeAdmin:false,excludeInternal:true};
    const filtered=readAnalytics(db,query,'summary',now) as AnalyticsSummary;
    assert.deepEqual(filtered.totals,{pv:4,uv:4,users:0,actions:3,hosting:3,logins:3,news:3});
    assert.deepEqual(filtered.daily[0].network,{public:2,internal:0,unknown:2});
    const unfiltered=readAnalytics(db,{...query,excludeInternal:false},'summary',now) as AnalyticsSummary;
    assert.deepEqual(unfiltered.daily[0].network,{public:2,internal:1,unknown:2});
    assert.equal(filtered.tools[0].opens,3);assert.equal(filtered.tools[0].actions,3);
    const visits=readAnalytics(db,query,'visits',now) as any[];
    assert.equal(visits.length,10);assert.ok(visits.every(row=>row.networkType!=='internal'));
    const withoutAdmins=readAnalytics(db,{...query,excludeAdmin:true},'summary',now) as AnalyticsSummary;
    assert.equal(withoutAdmins.totals.pv,3);
    assert.deepEqual(withoutAdmins.daily[0].network,{public:1,internal:0,unknown:2});
    appendAnalytics(db,[record(now+8*ANALYTICS_DAY)],now+8*ANALYTICS_DAY);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM analytics_events WHERE ip IS NOT NULL')!.n,26);
    assert.equal((readAnalytics(db,query,'summary',now+8*ANALYTICS_DAY) as AnalyticsSummary).totals.actions,3);
  }finally{sql.close();}
});

test('工具完整聚合保留打开次数最高但组合次数较低的工具',()=>{
  const sql=new DatabaseSync(':memory:');sql.exec(ANALYTICS_SCHEMA_SQL+HOSTING_SCHEMA_SQL);
  try{
    const db=nativeQueries(sql),now=Date.now(),[top,...otherTools]=ANALYTICS_TOOL_IDS;
    const events=otherTools.flatMap(toolId=>Array.from({length:3},()=>{
      const row=record(now);
      return {...row,event:{...row.event,name:'tool_action' as const,properties:{toolId,action:'copy' as const,result:'success' as const}}};
    }));
    appendAnalytics(db,[...events,...Array.from({length:2},()=>{
      const row=record(now);
      return {...row,event:{...row.event,name:'tool_open' as const,properties:{toolId:top}}};
    })],now);
    const {tools}=readAnalytics(db,{range:'today',excludeAdmin:false},'summary',now) as AnalyticsSummary;
    assert.equal(tools.length,ANALYTICS_TOOL_IDS.length);
    const mostOpened=tools.find(row=>row.label===top);
    assert.equal(mostOpened?.opens,2);
    assert.equal(mostOpened?.actions,0);
  }finally{sql.close();}
});

test('滚动24小时、自定义时刻与小时趋势使用同一窗口，期间访客独立去重',()=>{
  const sql=new DatabaseSync(':memory:');sql.exec(ANALYTICS_SCHEMA_SQL+HOSTING_SCHEMA_SQL);
  try{
    const db=nativeQueries(sql),now=Date.parse('2026-11-26T03:35:00+08:00'),start=now-ANALYTICS_DAY;
    const visitorId=randomUUID();
    appendAnalytics(db,[start-1,start,start+3600_000,now-1,now+1].flatMap(at=>{
      const page={...record(at),visitorId,networkType:'public' as const};
      const action=record(at);
      return [page,{...action,event:{...action.event,name:'feature_action',properties:{feature:'composer',action:'submit',surface:'composer',operationId:randomUUID()}}}];
    }),now);
    const rolling={range:'24h' as const,excludeAdmin:false};
    const summary=readAnalytics(db,rolling,'summary',now) as AnalyticsSummary;
    assert.equal(summary.since,start);assert.equal(summary.until,now);
    assert.equal(summary.totals.pv,3);assert.equal(summary.totals.uv,1);
    assert.equal(summary.trend?.step,3600_000);assert.equal(summary.trend?.points.length,3);
    const today=readAnalytics(db,{...rolling,range:'today'},'summary',now) as AnalyticsSummary;
    assert.equal(today.trend?.step,3600_000);assert.equal(today.daily[0].uv,1);
    const custom={range:'custom' as const,startAt:start,endAt:start+3600_000,excludeAdmin:false};
    const selected=readAnalytics(db,custom,'summary',now) as AnalyticsSummary;
    assert.equal(selected.totals.pv,2);assert.equal(selected.until,custom.endAt);
    assert.equal((readAnalytics(db,custom,'visits',now) as unknown[]).length,2);
    assert.equal((readFeatureAnalytics(db,custom,'features',undefined,now) as {messageSubmits:number}).messageSubmits,2);
    const actions=readFeatureAnalytics(db,custom,'actions',undefined,now) as {items:unknown[]};
    assert.equal(actions.items.length,2);
    const long=readAnalytics(db,{...custom,startAt:now-200*ANALYTICS_DAY,endAt:now},'summary',now) as AnalyticsSummary;
    assert.ok(long.trend&&long.trend.step>ANALYTICS_DAY);
    assert.equal(long.trend.points.reduce((total,row)=>total+row.pv,0),long.totals.pv);
  }finally{sql.close();}
});

test('采集入口为工具和资讯统一保存可信IP和网络分类，拒绝客户端自报网络分类',async()=>{
  const rows:AnalyticsRecord[]=[];
  const port={appendAnalytics:async(input:{records:AnalyticsRecord[]})=>{rows.push(...input.records);return{accepted:input.records.length};},authenticateSession:async()=>null};
  const service=new AnalyticsService(port),app=new Hono().route('/',createAnalyticsRouter({port:port as any,service}));
  const events=[{...record().event,name:'tool_open',properties:{toolId:'json'}},{...record().event,name:'tool_action',properties:{toolId:'json',action:'copy',result:'success'}},{...record().event,name:'news_click',properties:{newsId:'news'}}];
  const send=(batch:unknown[])=>app.request('http://relay.example/api/public/analytics/events',{method:'POST',headers:{origin:'http://localhost','x-relay-client-address':'192.168.1.9'},body:JSON.stringify({events:batch})},{incoming:{socket:{remoteAddress:'127.0.0.1'}}});
  try{
    assert.equal((await send(events)).status,204);await new Promise(resolve=>setTimeout(resolve,0));await service.close();
    assert.equal(rows.length,3);assert.ok(rows.every(row=>row.ip==='192.168.1.9'&&row.networkType==='internal'));
    assert.equal((await send([{...events[0],networkType:'public'}])).status,400);
  }finally{await service.close();}
});

test('详情仅投影补录标记，不暴露原始补录依据或批次',()=>{
  const sql=new DatabaseSync(':memory:');sql.exec(ANALYTICS_SCHEMA_SQL+HOSTING_SCHEMA_SQL);
  try{
    const db=nativeQueries(sql),r=record();appendAnalytics(db,[r]);
    const read=()=> (readAnalytics(db,{range:'today',excludeAdmin:false},'visits') as any[])[0];
    assert.equal(read().backfilled,false);
    for(const metadata of [{backfill:{batch:'private-batch',basis:['private-basis']}},{sourceBackfill:'private-batch'}]){
      db.run('UPDATE analytics_events SET properties=? WHERE id=?',[JSON.stringify(metadata),r.event.id]);
      const row=read();assert.equal(row.backfilled,true);assert.doesNotMatch(JSON.stringify(row),/private-batch|private-basis/);
    }
  }finally{sql.close();}
});

test('来源判定只还原可信本机网关的HTTPS，不把服务端HTTP误当外部来源入口',()=>{
  const request='http://relay.example/p/site';
  const trusted=analyticsSourceRequestUrl(request,'https',true,'127.0.0.1');assert.equal(trusted,'https://relay.example/p/site');
  assert.equal(classifyAnalyticsSource('https://relay.example/tools',trusted).sourceType,'internal');
  assert.equal(classifyAnalyticsSource('http://relay.example:80/other',trusted).sourceType,'external');
  assert.equal(analyticsSourceRequestUrl(request,'https',false,'127.0.0.1'),request);
  assert.equal(analyticsSourceRequestUrl(request,'https',true,'192.168.1.2'),request);
  assert.equal(analyticsSourceRequestUrl(request,'https, http',true,'127.0.0.1'),request);
  assert.equal(analyticsSourceRequestUrl(request,undefined,true,'127.0.0.1'),request);
});

test('托管网关前端版本独立保存，普通客户端不能宣称网关来源',()=>{
  assert.deepEqual(trustedGatewayFrontendContext('0.40.0',true,'127.0.0.1'),{clientSource:'gateway',clientVersion:'0.40.0'});
  assert.deepEqual(trustedGatewayFrontendContext('0.40.0',true,'::1'),{clientSource:'gateway',clientVersion:'0.40.0'});
  assert.deepEqual(trustedGatewayFrontendContext('0.40.0',false,'127.0.0.1'),{});
  assert.deepEqual(trustedGatewayFrontendContext('0.40.0',true,'192.168.1.2'),{});
  for(const value of [undefined,'bad version','x'.repeat(41),''])assert.deepEqual(trustedGatewayFrontendContext(value,true,'127.0.0.1'),{clientSource:'gateway'});
  assert.equal(AnalyticsClientEventSchema.safeParse({...record().event,clientSource:'gateway'}).success,false);
  const dbRaw=new DatabaseSync(':memory:');dbRaw.exec(ANALYTICS_SCHEMA_SQL+HOSTING_SCHEMA_SQL);
  try{
    const db=nativeQueries(dbRaw),r=record();
    appendAnalytics(db,[{...r,version:'0.54.1',event:{...r.event,name:'hosting_document',page:'hosting',clientSource:'gateway',clientVersion:'0.40.0',properties:{siteId:'site'}}}]);
    const saved=(readAnalytics(db,{range:'today',excludeAdmin:false},'visits') as any[])[0];
    assert.equal(saved.clientSource,'gateway');assert.equal(saved.clientVersion,'0.40.0');assert.equal(saved.serverVersion,'0.54.1');
  }finally{dbRaw.close();}
});
test('请求环境补齐登录/托管与旧客户端缺失值，访问主机不受转发头或事件字段控制',async()=>{
  const rows:AnalyticsRecord[]=[];
  const port={appendAnalytics:async(input:{records:AnalyticsRecord[]})=>{rows.push(...input.records);return{accepted:input.records.length};},authenticateSession:async()=>null};
  const service=new AnalyticsService(port),app=new Hono().route('/',createAnalyticsRouter({port:port as any,service}));
  app.get('/hosting-test',c=>{service.server(c,'hosting_document',{siteId:'site'});return c.text('ok');});
  app.get('/login-test',c=>{service.server(c,'login_result',{result:'rejected'});return c.text('ok');});
  const ua='Mozilla/5.0 (Phone; OpenHarmony 6.0; Android 10) Chrome/132.0 Mobile HuaweiBrowser/6.1';
  const missing={...record().event,device:'unknown',browser:'Other',os:'Other'};
  const headers={origin:'http://localhost','user-agent':ua,'x-forwarded-host':'spoof.example'};
  try{
    assert.equal((await app.request('http://relay.example/api/public/analytics/events',{method:'POST',headers,body:JSON.stringify({events:[missing]})})).status,204);
    await new Promise(resolve=>setTimeout(resolve,0));
    await app.request('http://192.0.2.10/hosting-test',{headers});await new Promise(resolve=>setTimeout(resolve,0));
    await app.request('http://[::1]/login-test',{headers});await new Promise(resolve=>setTimeout(resolve,0));
    // Higher-quality browser evidence remains authoritative (e.g. desktop-UA iPad).
    const precise={...record().event,device:'tablet',os:'iPadOS',browser:'Safari'};
    await app.request('http://relay.example/api/public/analytics/events',{method:'POST',headers,body:JSON.stringify({events:[precise]})});await new Promise(resolve=>setTimeout(resolve,0));
    await app.request('http://relay.example/hosting-test');await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal((await app.request('http://relay.example/api/public/analytics/events',{method:'POST',headers,body:JSON.stringify({events:[{...missing,accessHost:'spoof.example'}]})})).status,400);
    await service.close();assert.equal(rows.length,5);
    for(const r of rows.slice(0,3))assert.deepEqual([r.event.device,r.event.browser,r.event.os],['mobile','Huawei','HarmonyOS']);
    assert.deepEqual(rows.map(r=>r.accessHost),['relay.example','192.0.2.10','::1','relay.example','relay.example']);
    assert.equal(rows[1].event.clientSource,undefined);assert.equal(rows[1].event.clientVersion,undefined);
    assert.deepEqual([rows[3].event.device,rows[3].event.os,rows[3].event.browser],['tablet','iPadOS','Safari']);
    assert.deepEqual([rows[4].event.device,rows[4].event.os,rows[4].event.browser],['unknown','Other','Other']);
    assert.doesNotMatch(JSON.stringify(rows),/Mozilla|user-agent|spoof/);
    const sql=new DatabaseSync(':memory:');sql.exec(ANALYTICS_SCHEMA_SQL+HOSTING_SCHEMA_SQL);
    try{
      const db=nativeQueries(sql);appendAnalytics(db,rows);
      const visits=readAnalytics(db,{range:'today',excludeAdmin:false},'visits') as any[];
      assert.equal(visits.find(r=>r.accessHost==='relay.example').accessType,'domain');
      assert.equal(visits.find(r=>r.accessHost==='192.0.2.10').accessType,'ip');
      assert.equal(visits.find(r=>r.accessHost==='::1').accessType,'ip');
    }finally{sql.close();}
  }finally{await service.close();}
});
test('内网访问主机持久化并归类为IP，旧记录保留缺失',()=>{
  const sql=new DatabaseSync(':memory:');sql.exec(ANALYTICS_SCHEMA_SQL+HOSTING_SCHEMA_SQL);
  try{
    const db=nativeQueries(sql),now=Date.now();
    const hosts=['192.168.1.23','10.0.0.2','172.16.0.2','fd00::1','relay.example'];
    const rows=hosts.map(accessHost=>({...record(now),accessHost})),legacy=record(now);
    appendAnalytics(db,[...rows,legacy],now);
    const visits=readAnalytics(db,{range:'today',excludeAdmin:false},'visits',now) as Array<{id:string;accessHost:string|null;accessType:string|null}>;
    for(const row of rows){const saved=visits.find(v=>v.id===row.event.id)!;assert.equal(saved.accessHost,row.accessHost);assert.equal(saved.accessType,row.accessHost==='relay.example'?'domain':'ip');}
    assert.equal(visits.find(v=>v.id===legacy.event.id)!.accessHost,null);
    assert.equal(visits.find(v=>v.id===legacy.event.id)!.accessType,null);
  }finally{sql.close();}
});

test('来源状态独立持久化，来源汇总按PV区分无信息、站内、外部及旧未记录',()=>{
  const sql=new DatabaseSync(':memory:');sql.exec(ANALYTICS_SCHEMA_SQL+HOSTING_SCHEMA_SQL);
  try{
    const db=nativeQueries(sql),now=Date.now();
    const make=(sourceType:'external'|'internal'|'none'|undefined,referrerHost:string|null)=>{const r=record(now);return{...r,event:{...r.event,...(sourceType?{sourceType}:{}),referrerHost}};};
    const external=make('external','outside.example'),none=make('none',null),internal=make('internal',null),legacy=make(undefined,null),oldExternal=make(undefined,'old.example');
    appendAnalytics(db,[external,none,internal,legacy,oldExternal],now);
    const summary=readAnalytics(db,{range:'today',excludeAdmin:false},'summary',now) as AnalyticsSummary;
    assert.deepEqual(new Set(summary.sources.map(r=>r.label)),new Set(['external:outside.example','external:old.example','none','internal','unknown']));
    const visits=readAnalytics(db,{range:'today',excludeAdmin:false},'visits',now) as any[];
    assert.equal(visits.find(r=>r.id===none.event.id).sourceType,'none');assert.equal(visits.find(r=>r.id===legacy.event.id).sourceType,null);
    assert.equal(visits.find(r=>r.id===oldExternal.event.id).sourceType,'external');
    assert.throws(()=>appendAnalytics(db,[make('external',null)],now));assert.throws(()=>appendAnalytics(db,[make('none','outside.example')],now));
    assert.equal(AnalyticsClientEventSchema.safeParse({...legacy.event,sourceType:'direct'}).success,false);
    appendAnalytics(db,[make('external','2001:db8::1')],now);
  }finally{sql.close();}
});

test('托管请求从Referer采集外部或站内来源，空来源与非法来源区分',async()=>{
  const rows:AnalyticsRecord[]=[],port={appendAnalytics:async(input:{records:AnalyticsRecord[]})=>{rows.push(...input.records);return{accepted:input.records.length};},authenticateSession:async()=>null};
  const service=new AnalyticsService(port),app=new Hono().get('/p/site',c=>{service.server(c,'hosting_document',{siteId:'site'});return c.text('ok');});
  try{
    for(const referer of ['https://outside.example/article?token=secret','http://relay.example/tools','','not-a-url']){
      assert.equal((await app.request('http://relay.example/p/site',{headers:referer?{referer}:{}})).status,200);await new Promise(resolve=>setTimeout(resolve,0));
    }
    await service.close();assert.equal(rows.length,4);
    assert.deepEqual(rows.map(r=>r.event.sourceType),['external','internal','none',undefined]);
    assert.deepEqual(rows.map(r=>r.event.referrerHost),['outside.example',null,null,null]);assert.doesNotMatch(JSON.stringify(rows),/article|token|secret|not-a-url/);
  }finally{await service.close();}
});

test('扩充的系统与浏览器通过封闭Schema和存储读取，不接受任意分类',()=>{
  const sql=new DatabaseSync(':memory:');sql.exec(ANALYTICS_SCHEMA_SQL+HOSTING_SCHEMA_SQL);const db=nativeQueries(sql),now=Date.now();
  try{
    const pairs=[['HarmonyOS','Huawei'],['HyperOS','Xiaomi'],['MIUI','QQ'],['iPadOS','UC'],['Android','Quark'],['Android','Samsung'],['iOS','Opera']] as const;
    const rows=pairs.map(([os,browser])=>{const r=record(now);return{...r,event:{...r.event,os,browser}};});
    assert.equal(appendAnalytics(db,rows,now).accepted,pairs.length);
    const visits=readAnalytics(db,{range:'today',excludeAdmin:false},'visits',now) as Array<{os:string;browser:string}>;
    for(const [os,browser] of pairs)assert.ok(visits.some(row=>row.os===os&&row.browser===browser));
    const bad=record(now);assert.throws(()=>appendAnalytics(db,[{...bad,event:{...bad.event,browser:'arbitrary-browser' as any}}],now));
  }finally{sql.close();}
});
test('Web/PWA和客户端版本独立持久化，旧记录不从服务端版本补写',()=>{
  const sql=new DatabaseSync(':memory:');sql.exec(ANALYTICS_SCHEMA_SQL+HOSTING_SCHEMA_SQL);const db=nativeQueries(sql),now=Date.now(),legacy=record(now);
  const modern=record(now),web=record(now);
  try{
    appendAnalytics(db,[legacy,{...modern,version:'0.54.2',event:{...modern.event,clientSource:'pwa',clientVersion:'0.54.1'}},{...web,event:{...web.event,clientSource:'web',clientVersion:'0.54.0'}}],now);
    const visits=readAnalytics(db,{range:'today',excludeAdmin:false},'visits',now) as Array<{id:string;clientSource:string|null;clientVersion:string|null;serverVersion:string}>;
    assert.deepEqual(visits.find(r=>r.id===legacy.event.id)?.clientSource,null);assert.equal(visits.find(r=>r.id===legacy.event.id)?.clientVersion,null);
    const saved=visits.find(r=>r.id===modern.event.id)!;
    assert.equal(saved.clientSource,'pwa');assert.equal(saved.clientVersion,'0.54.1');assert.equal(saved.serverVersion,'0.54.2');
    assert.equal(visits.find(r=>r.id===web.event.id)?.clientSource,'web');
    assert.throws(()=>appendAnalytics(db,[{...web,event:{...web.event,clientSource:'unknown-app' as any}}],now));
    assert.throws(()=>appendAnalytics(db,[{...web,event:{...web.event,clientVersion:'x'.repeat(41)}}],now));
  }finally{sql.close();}
});
test('事件去重、聚合、管理员排除与所有时间查询保留历史IP',()=>{
  const sql=new DatabaseSync(':memory:');sql.exec(ANALYTICS_SCHEMA_SQL+HOSTING_SCHEMA_SQL);const db=nativeQueries(sql),now=Date.now(),r=record(now);
  try{
    assert.equal(appendAnalytics(db,[r,r],now).accepted,1);
    appendAnalytics(db,[{...record(now),role:'admin',userId:'admin'},record(now-8*ANALYTICS_DAY)],now);
    const summary=readAnalytics(db,{range:'30d',excludeAdmin:true},'summary',now) as AnalyticsSummary;
    assert.equal(summary.totals.pv,2);assert.equal(summary.totals.uv,2);
    const visits=readAnalytics(db,{range:'30d',excludeAdmin:true},'visits',now) as any[];
    assert.equal(visits.find(v=>v.at===now-8*ANALYTICS_DAY).ip,'203.0.113.9');
    const before=record(now-31*ANALYTICS_DAY);assert.equal(appendAnalytics(db,[before],now).accepted,1);
    const all=readAnalytics(db,{range:'all',excludeAdmin:true},'summary',now) as AnalyticsSummary;
    assert.equal(all.totals.pv,3);
    const history=readAnalytics(db,{range:'all',excludeAdmin:true},'visits',now) as any[];
    assert.equal(history.find(v=>v.at===before.receivedAt).ip,'203.0.113.9');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM analytics_events')!.n,4);
  }finally{sql.close();}
});
test('真实Worker复核管理员，采集匿名身份与事件白名单；不写业务回执',async()=>{
  const f=fixture();
  f.mutate(HOSTING_SCHEMA_SQL);
  f.mutate(`UPDATE auth_sessions SET token_hash='${hashSessionToken('analytics-admin')}' WHERE user_id='admin'; UPDATE auth_sessions SET token_hash='${hashSessionToken('analytics-owner')}' WHERE user_id='owner'`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const service=new AnalyticsService(port),app=new Hono().route('/',createAnalyticsRouter({port,service}));
  try{
    const e={...record().event,sourceType:'none' as const};
    const send=(events:unknown[])=>app.request('/api/public/analytics/events',{method:'POST',headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({events})});
    const accepted=await send([e]);assert.equal(accepted.status,204);assert.match(accepted.headers.get('set-cookie')! ,/^relay_analytics_id=/);
    assert.doesNotMatch(accepted.headers.get('set-cookie')!,/relay_client_id=/);
    await service.close();
    assert.equal((await app.request('/api/admin/analytics/summary')).status,401);
    assert.equal((await app.request('/api/admin/analytics/summary',{headers:{cookie:'relay_session=analytics-owner'}})).status,403);
    const result=await app.request('/api/admin/analytics/summary',{headers:{cookie:'relay_session=analytics-admin'}});
    assert.equal(result.status,200);assert.equal((await result.json() as AnalyticsSummary).totals.pv,1);
    for(const view of ['summary','visits']){
      assert.equal((await app.request(`/api/admin/analytics/${view}?excludeInternal=true&excludeAdmin=true`,{headers:{cookie:'relay_session=analytics-admin'}})).status,200);
      assert.equal((await app.request(`/api/admin/analytics/${view}?excludeInternal=invalid`,{headers:{cookie:'relay_session=analytics-admin'}})).status,400);
      assert.equal((await app.request(`/api/admin/analytics/${view}?range=all`,{headers:{cookie:'relay_session=analytics-admin'}})).status,200);
      assert.equal((await app.request(`/api/admin/analytics/${view}?range=30d`,{headers:{cookie:'relay_session=analytics-admin'}})).status,200);
    }
    const visits=await app.request('/api/admin/analytics/visits',{headers:{cookie:'relay_session=analytics-admin'}});
    assert.equal(visits.status,200);
    const saved=await visits.json() as Array<{accessHost:string;accessType:string;sourceType:string}>;
    assert.equal(saved[0].accessHost,'localhost');assert.equal(saved[0].accessType,'domain');
    assert.equal(saved[0].sourceType,'none');
    assert.equal((await send([{...e,userId:'admin'}])).status,400);
    assert.equal((await send([{...e,name:'login_result'}])).status,400);
    assert.equal((await app.request('/api/public/analytics/events',{method:'POST',headers:{origin:'null'},body:'{}'})).status,403);
    await assert.rejects(port.readAnalytics({principal:{kind:'user',userId:'owner',authSessionHash:hashSessionToken('analytics-owner')},query:{range:'7d',excludeAdmin:false},view:'summary'}),{code:'FORBIDDEN'});
    assert.equal(f.scalar('SELECT COUNT(*) FROM _relay_storage_operations'),0);
  }finally{await service.close();await port.close();f.cleanup();}
});

test('同一登录意图成功重放可纠正暂时报错，后续失败不能覆盖成功',()=>{
  const sql=new DatabaseSync(':memory:');sql.exec(ANALYTICS_SCHEMA_SQL);const db=nativeQueries(sql),now=Date.now();
  const base=record(now-1000);
  const failed:AnalyticsRecord={...base,event:{...base.event,name:'login_result',page:'login',properties:{result:'error'}}};
  const success:AnalyticsRecord={...failed,receivedAt:now,userId:'admin',role:'admin',event:{...failed.event,name:'login_result',properties:{result:'success'}}};
  try{
    appendAnalytics(db,[failed],now);appendAnalytics(db,[success],now);appendAnalytics(db,[failed],now);
    const rows=db.all('SELECT received_at,user_id,role,properties FROM analytics_events');
    assert.equal(rows.length,1);assert.equal(rows[0].received_at,base.receivedAt);
    assert.equal(rows[0].user_id,'admin');assert.equal(rows[0].role,'admin');
    assert.equal(JSON.parse(String(rows[0].properties)).result,'success');
  }finally{sql.close();}
});

test('采集Cookie独立于登录Cookie，已有客户端标识只读继承且后续优先统计标识',async()=>{
  const records:AnalyticsRecord[]=[];
  const port={appendAnalytics:async(input:{records:AnalyticsRecord[]})=>{records.push(...input.records);return{accepted:input.records.length};},authenticateSession:async()=>null};
  const service=new AnalyticsService(port),app=new Hono().route('/',createAnalyticsRouter({port:port as any,service}));
  const clientId=randomUUID(),analyticsId=randomUUID();
  const send=(cookie:string)=>app.request('/api/public/analytics/events',{method:'POST',headers:{cookie,origin:'http://localhost'},body:JSON.stringify({events:[record().event]})});
  try{
    const first=await send(`relay_client_id=${clientId}`);
    assert.equal(first.status,204);assert.match(first.headers.get('set-cookie')!,new RegExp(`^relay_analytics_id=${clientId};`));
    assert.doesNotMatch(first.headers.get('set-cookie')!,/relay_client_id=/);
    const next=await send(`relay_client_id=${clientId}; relay_analytics_id=${analyticsId}`);
    assert.equal(next.status,204);assert.equal(next.headers.get('set-cookie'),null);
    await service.close();assert.deepEqual(records.map(r=>r.visitorId),[clientId,analyticsId]);
  }finally{await service.close();}
});

test('超过原10万条不删除历史；统计队列满或存储失败不会阻塞业务',async()=>{
  const sql=new DatabaseSync(':memory:');sql.exec(ANALYTICS_SCHEMA_SQL);const db=nativeQueries(sql),now=Date.now();
  try{
    const r=record(now);
    sql.exec('BEGIN');
    const insert=sql.prepare('INSERT INTO analytics_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for(let i=0;i<100_000;i++)insert.run(String(i),now-1000,'page_view','tools',null,null,null,'guest',null,'0',null,'unknown','Other','Other','{}');
    sql.exec('COMMIT');appendAnalytics(db,[r],now);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM analytics_events')!.n,100_001);
    assert.ok(db.get('SELECT id FROM analytics_events WHERE id=?',[r.event.id]));
  }finally{sql.close();}
  let release!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  const service=new AnalyticsService({appendAnalytics:async()=>{await waiting;return{accepted:1};},authenticateSession:async()=>null});
  assert.equal(service.enqueue([record()]),true);
  for(let i=0;i<20;i++)assert.equal(service.enqueue([record()]),true);
  assert.equal(service.enqueue([record()]),false);
  release();await service.close();assert.equal(service.enqueue([record()]),false);
  const failed=new AnalyticsService({appendAnalytics:()=>{throw Error('synthetic-failure');},authenticateSession:async()=>null});
  assert.doesNotThrow(()=>failed.enqueue([record()]));await failed.close();
});

test('采集限制未知/超大载荷与同访客频率，禁用时不触发存储；登录意图ID稳定',async()=>{
  let writes=0,authReads=0;
  const port={appendAnalytics:async()=>{writes++;return{accepted:1};},authenticateSession:async()=>{authReads++;return null;}};
  const service=new AnalyticsService(port),app=new Hono().route('/',createAnalyticsRouter({port:port as any,service}));
  const cookie=`relay_client_id=${randomUUID()}`;
  const send=(body:string)=>app.request('/api/public/analytics/events',{method:'POST',headers:{cookie,origin:'http://localhost'},body});
  try{
    assert.equal((await send(JSON.stringify({events:Array(21).fill(record().event)}))).status,400);
    assert.equal((await send(' '.repeat(16*1024+1))).status,400);
    for(let i=0;i<30;i++)assert.equal((await send(JSON.stringify({events:[record().event]}))).status,204);
    assert.equal((await send(JSON.stringify({events:[record().event]}))).status,429);
    assert.equal(authReads,0,'visitor-only requests do not query authentication');
    await service.close();
    const disabled=new AnalyticsService(port,false),disabledApp=new Hono().route('/',createAnalyticsRouter({port:port as any,service:disabled}));
    const before=writes;
    assert.equal((await disabledApp.request('/api/public/analytics/events',{method:'POST',body:'{}'})).status,204);
    assert.equal(writes,before);await disabled.close();
    const id=analyticsLoginId('same-intent');assert.equal(id,analyticsLoginId('same-intent'));assert.notEqual(id,analyticsLoginId('other-intent'));
    assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
  }finally{await service.close();}
});
