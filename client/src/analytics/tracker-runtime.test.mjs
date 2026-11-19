import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTracker,sendAnalytics } from './tracker.ts';
import { attachAnalyticsLifecycle } from './lifecycle.ts';
import {createFeatureViewObserver} from './feature-view.ts';

const meta=()=>({device:'desktop',browser:'Chrome',os:'Windows',referrerHost:null});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
function fixture(extra={}){
  const sent=[];
  const tracker=createTracker({enabled:()=>true,extendedEnabled:()=>true,meta,send:async(body,keepalive,signal)=>{sent.push({body:JSON.parse(body),raw:body,keepalive,signal});return{ok:true};},...extra});
  return{tracker,sent};
}
const local=(extra={})=>({feature:'file_preview',action:'load',surface:'preview_content',operationId:randomUUID(),result:'success',...extra});

test('功能挂载等待页面就绪，StrictMode不双计，卸载关闭沿用原上下文且取消监听',async()=>{
  const {tracker:t,sent}=fixture();t.reset();
  const observer=createFeatureViewObserver(t);
  const first=observer.mount('settings',true,'user_menu');
  assert.equal(t.size(),0);t.page('chat','a','user');
  first();const second=observer.mount('settings',true,'user_menu');await tick();
  await t.flush();const events=sent.flatMap(batch=>batch.body.events);
  assert.equal(events.filter(e=>e.name==='feature_view').length,1);assert.equal(events.filter(e=>e.properties.action==='close').length,0);
  t.page('news','b','user');second();await tick();await t.flush();
  const closed=sent.flatMap(batch=>batch.body.events).filter(e=>e.properties.action==='close');
  assert.equal(closed.length,1);assert.equal(closed[0].page,'chat');assert.equal(closed[0].pageViewId,events[0].pageViewId);
  t.page('tools','c','user');await t.flush();
  assert.equal(sent.flatMap(batch=>batch.body.events).filter(e=>e.name==='feature_view').length,1);
});

test('扩展总开关默认关闭；关闭后不发送积压的新版事件，旧六类继续',async()=>{
  let extended=false;
  const {tracker:t,sent}=fixture({extendedEnabled:()=>extended});
  const token={};
  assert.equal(t.view({feature:'settings',surface:'user_menu'},token),false);
  t.page('chat','a','user');
  extended=true;assert.equal(t.view({feature:'settings',surface:'user_menu'},token),true);
  extended=false;await t.flush();
  assert.deepEqual(sent[0].body.events.map(e=>e.name),['page_view']);
});

test('同身份异步完成使用原page/view/source，元信息按身份缓存且不复制额外字段',async()=>{
  let reads=0;
  const {tracker:t,sent}=fixture({meta:()=>{reads++;return{...meta(),sourceType:'external',referrerHost:'search.example',userAgent:'PRIVATE_SENTINEL'};}});
  t.page('tools','a','user');
  const captured=t.capture();await t.flush();const original=sent[0].body.events[0];
  t.page('news','b','user');
  assert.equal(captured.track('tool_action',{toolId:'qr',action:'export_png',result:'success'}),true);
  await t.flush();
  const [page,result]=sent[1].body.events;
  assert.equal(page.sourceType,'internal');
  assert.deepEqual([result.page,result.pageViewId,result.sourceType,result.referrerHost],[original.page,original.pageViewId,'external','search.example']);
  assert.equal(reads,1);
  assert.doesNotMatch(JSON.stringify(sent),/PRIVATE_SENTINEL|userAgent/);
  t.page('chat','c','other');await t.flush();assert.equal(reads,2);
});

test('换账号清队列/中止在途请求/作废旧句柄，不把迟到失败计到新账号',async()=>{
  const first=deferred(),calls=[];
  const {tracker:t}=fixture({send:async(body,keepalive,signal)=>{calls.push({body:JSON.parse(body),signal});if(calls.length===1)return first.promise;return{ok:true};}});
  t.page('chat','a','old');const captured=t.capture(),request=t.flush();
  t.track('tool_open',{toolId:'qr'});
  t.reset();assert.equal(calls[0].signal.aborted,true);
  assert.equal(t.track('tool_open',{toolId:'qr'}),false,'身份确认前不继续采集');
  t.page('chat','a','new');
  assert.equal(captured.track('tool_open',{toolId:'qr'}),false);
  first.resolve({ok:false});await request;
  assert.equal(t.quality().rejected,0);
  await t.flush();
  assert.equal(calls.length,2);assert.equal(calls[1].body.events.length,1);
  assert.equal(t.quality().sent,1);
});

test('功能主点按弱引用实例去重，真实关闭再开及身份变化可重新访问',async()=>{
  const {tracker:t,sent}=fixture();const instance={};
  t.page('chat','a','user');
  assert.equal(t.view({feature:'settings',surface:'user_menu'},instance),true);
  assert.equal(t.view({feature:'settings',surface:'user_menu'},instance),false,'重渲染/重复挂载不双计');
  t.page('tools','b','user');
  assert.equal(t.view({feature:'settings',surface:'user_menu'},instance),false,'持久面板不会因路由变化重记');
  t.endView(instance);assert.equal(t.view({feature:'settings',surface:'user_menu'},instance),true);
  await t.flush();assert.equal(sent[0].body.events.filter(e=>e.name==='feature_view').length,2);
  t.page('chat','c','other');assert.equal(t.view({feature:'settings',surface:'user_menu'},instance),true);
});

test('登录失败后恢复原访客采集，不重记PV或复活旧操作，身份不同不能恢复',async()=>{
  const {tracker:t,sent}=fixture();
  t.page('login','a','guest');const captured=t.capture();await t.flush();
  const original=sent[0].body.events[0];
  t.reset();t.resume('other');assert.equal(t.track('tool_open',{toolId:'qr'}),false);
  t.resume('guest');assert.equal(t.track('tool_open',{toolId:'qr'}),true);
  assert.equal(captured.track('tool_open',{toolId:'qr'}),false);
  t.page('login','a','guest');await t.flush();
  assert.equal(sent[1].body.events.length,1);
  assert.equal(sent[1].body.events[0].pageViewId,original.pageViewId);
});

test('异步结果一次结算、冻结发起属性、按单调时钟计时，不能冒充服务端结果',async()=>{
  let clock=10;const {tracker:t,sent}=fixture({now:()=>clock});
  t.page('chat','a','user');
  const input={feature:'file_preview',action:'load',surface:'message_file',fileKind:'pdf'};
  const finish=t.captureResult(input);input.fileKind='html';
  t.page('news','b','user');clock=35;
  assert.equal(finish('error',{reasonCode:'LOAD_FAILED'}),true);assert.equal(finish('success'),false);
  assert.equal(t.result(local({feature:'conversation',action:'run'})),false);
  await t.flush();const result=sent[0].body.events.find(e=>e.name==='operation_result');
  assert.equal(result.page,'chat');assert.equal(result.properties.durationMs,25);assert.equal(result.properties.fileKind,'pdf');
  assert.match(result.properties.operationId,/^[0-9a-f-]{36}$/);
  const late=t.captureResult({feature:'file_preview',action:'load',surface:'unknown'});
  t.reset();t.page('chat','c','user');assert.equal(late('success'),false);
});

test('验证发生在网络前，拒绝内容/非法值，不调用非枚举toJSON泄漏对象',async()=>{
  const {tracker:t,sent}=fixture();
  for(const bad of [
    {...local(),filePath:'PRIVATE_SENTINEL'}, {...local(),durationMs:'PRIVATE_SENTINEL'},
    {...local(),fileKind:'PRIVATE_SENTINEL'}, {...local(),result:'PRIVATE_SENTINEL'},
    {...local(),feature:{toString:()=> 'file_preview',secret:'PRIVATE_SENTINEL'}},
  ]) assert.equal(t.result(bad),false);
  assert.equal(t.track('news_click',{newsId:'news',url:'PRIVATE_SENTINEL'}),false);
  const safe={toolId:'qr'};Object.defineProperty(safe,'toJSON',{value:()=>({secret:'PRIVATE_SENTINEL'})});
  assert.equal(t.track('tool_open',safe),true);safe.toolId='json';
  await t.flush();assert.equal(sent[0].body.events[0].properties.toolId,'qr');
  assert.doesNotMatch(JSON.stringify(sent),/PRIVATE_SENTINEL/);
  assert.equal(t.quality().invalid,6);
});

test('单请求在途且按UTF-8字节线性组批，非2xx不重试，后续事件可发送',async()=>{
  const first=deferred(),sent=[];let active=0,maximum=0;
  const {tracker:t}=fixture({
    // Synthetic metadata stresses the byte cap independently of host normalization.
    meta:()=>({...meta(),referrerHost:'域'.repeat(253),sourceType:'external'}),
    send:async(body,keepalive)=>{
      active++;maximum=Math.max(maximum,active);sent.push({raw:body,body:JSON.parse(body),keepalive});
      try{if(sent.length===1)return await first.promise;return{ok:true};}finally{active--;}
    },
  });
  for(let i=0;i<45;i++)t.track('news_click',{newsId:'x'.repeat(128)});
  assert.equal(sent.length,1);first.resolve({ok:false});await tick();
  assert.ok(t.quality().rejected>0);assert.equal(sent.length,1,'失败批次不自动重发或连续重试');
  while(t.size()){await t.flush();await tick();}
  assert.equal(maximum,1);
  assert.equal(sent.reduce((sum,batch)=>sum+batch.body.events.length,0),45);
  assert.ok(sent.every(batch=>Buffer.byteLength(batch.raw)<=16*1024&&batch.body.events.length<=20&&batch.body.events.length>0));
  assert.equal(new Set(sent.flatMap(batch=>batch.body.events.map(e=>e.id))).size,45);
});

test('50条有界队列优先保留结果，低优先级不能挤掉全结果队列',async()=>{
  const first=deferred(),sent=[];
  const {tracker:t}=fixture({send:async body=>{sent.push(JSON.parse(body));if(sent.length===1)return first.promise;return{ok:false};}});
  for(let i=0;i<20;i++)t.track('tool_open',{toolId:'qr'});
  for(let i=0;i<50;i++)assert.equal(t.result(local()),true);
  assert.equal(t.view({feature:'settings',surface:'user_menu'},{}),false);
  assert.equal(t.result(local({result:'error',reasonCode:'LOAD_FAILED'})),true);
  assert.equal(t.size(),50);assert.equal(t.quality().overflow,2);
  first.resolve({ok:false});await tick();
  while(t.size())await t.flush();
  assert.equal(sent.slice(1).flatMap(b=>b.events).length,50);
  assert.ok(sent.slice(1).flatMap(b=>b.events).every(e=>e.name==='operation_result'));
  assert.equal(sent.at(-1).events.at(-1).properties.result,'error');
});

test('隐藏时请求keepalive，发送中的隐藏通知只触发一次后续flush',async()=>{
  const first=deferred(),calls=[];
  const {tracker:t}=fixture({send:async(body,keepalive)=>{calls.push({body:JSON.parse(body),keepalive});if(calls.length===1)return first.promise;return{ok:true};}});
  t.track('tool_open',{toolId:'qr'});const pending=t.flush();
  t.track('tool_open',{toolId:'json'});void t.flush(true);void t.flush(true);
  assert.equal(calls.length,1);first.resolve({ok:true});await pending;await tick();
  assert.equal(calls.length,2);assert.equal(calls[1].keepalive,true);assert.equal(t.size(),0);
});

test('定时和hidden/pagehide生命周期共享且完整清理，不随挂载重复增长',async()=>{
  const host=new EventTarget(),doc=Object.assign(new EventTarget(),{visibilityState:'visible'});
  let callback,created=0,cleared=0;const calls=[];
  const schedule={set:(cb,ms)=>{assert.equal(ms,5000);callback=cb;created++;return 1;},clear:()=>{cleared++;}};
  const target={flush:async keep=>{calls.push(keep);}};
  const first=attachAnalyticsLifecycle(target,host,doc,schedule),second=attachAnalyticsLifecycle(target,host,doc,schedule);
  assert.equal(created,1);callback();doc.dispatchEvent(new Event('visibilitychange'));
  doc.visibilityState='hidden';doc.dispatchEvent(new Event('visibilitychange'));host.dispatchEvent(new Event('pagehide'));
  assert.deepEqual(calls,[false,true,true]);
  first();first();assert.equal(cleared,0);second();assert.equal(cleared,1);
  host.dispatchEvent(new Event('pagehide'));doc.dispatchEvent(new Event('visibilitychange'));assert.equal(calls.length,3);
  const remount=attachAnalyticsLifecycle(target,host,doc,schedule);assert.equal(created,2);remount();assert.equal(cleared,2);
});

test('传输5秒截止和身份中止信号均传给fetch，结束后移除监听/定时器',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const original=globalThis.fetch,signals=[];
  globalThis.fetch=async(_url,options)=>new Promise((_resolve,reject)=>{
    signals.push(options.signal);
    const abort=()=>reject(new Error('aborted'));
    if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});
  });
  try{
    const timeout=assert.rejects(sendAnalytics('{}',true),/aborted/);
    t.mock.timers.tick(4999);assert.equal(signals[0].aborted,false);
    t.mock.timers.tick(1);await timeout;
    const parent=new AbortController(),cancel=assert.rejects(sendAnalytics('{}',false,parent.signal),/aborted/);
    parent.abort();await cancel;assert.equal(signals[1].aborted,true);
  }finally{globalThis.fetch=original;}
});
