import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createTracker,normalizeAnalyticsEnvironment,collectAnalyticsMeta } from './tracker.ts';
import { parseClientEnvironment } from '../utils/client-environment.ts';
const meta=()=>({device:'desktop',browser:'Chrome',os:'Windows',referrerHost:null});
test('浏览器真实采集入口读取navigator，随页面事件发送完整环境而非注入meta替身',async()=>{
  const keys=['navigator','window','document','location','__RELAY_VERSION__','__RELAY_SOURCE_ORIGINS__'];
  const original=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
  const set=(key,value)=>Object.defineProperty(globalThis,key,{configurable:true,value});
  try{
    set('window',{matchMedia:()=>({matches:false})});set('document',{referrer:''});set('location',{host:'relay.example',href:'https://relay.example/'});set('__RELAY_VERSION__','0.54.1');
    for(const [ua,device,browser,os] of [
      ['Mozilla/5.0 (Phone; OpenHarmony 6.0) Mobile HuaweiBrowser/6.1','mobile','Huawei','HarmonyOS'],
      ['Mozilla/5.0 (Linux; Android 14; HyperOS/2.0) Chrome/130.0 Mobile MiuiBrowser/18.0','mobile','Xiaomi','HyperOS'],
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1','mobile','Safari','iOS'],
      ['Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0','desktop','Edge','Windows'],
    ]){
      set('navigator',{userAgent:ua,platform:'',maxTouchPoints:0});
      const sent=[],t=createTracker({enabled:()=>true,meta:collectAnalyticsMeta,send:async body=>sent.push(JSON.parse(body))});
      t.page('chat','/','guest');await t.flush();
      assert.equal(sent.length,1,ua);const e=sent[0].events[0];
      assert.deepEqual([e.device,e.browser,e.os,e.clientSource,e.clientVersion],[device,browser,os,'web','0.54.1'],ua);
      assert.doesNotMatch(JSON.stringify(e),/Mozilla|userAgent/);
    }
    set('window',{matchMedia:()=>({matches:true})});assert.equal(collectAnalyticsMeta().clientSource,'pwa');
    set('document',{referrer:'https://external.example/article?token=private'});
    assert.equal(collectAnalyticsMeta().referrerHost,'external.example');
    assert.doesNotMatch(JSON.stringify(collectAnalyticsMeta()),/article|token|private/);
    set('document',{referrer:'https://relay.example/other'});assert.equal(collectAnalyticsMeta().referrerHost,null);
    assert.equal(collectAnalyticsMeta().sourceType,'internal');
    set('__RELAY_SOURCE_ORIGINS__',['http://127.0.0.1:9081']);set('document',{referrer:'http://127.0.0.1:9081/tools'});assert.equal(collectAnalyticsMeta().sourceType,'internal');
    set('document',{referrer:''});assert.equal(collectAnalyticsMeta().referrerHost,null);
    assert.equal(collectAnalyticsMeta().sourceType,'none');
  }finally{keys.forEach((key,i)=>{if(original[i])Object.defineProperty(globalThis,key,original[i]);else delete globalThis[key];});}
});
test('实际环境解析到埋点的映射保留手机/Android及iPad和HarmonyOS',()=>{
  const android=parseClientEnvironment({userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36',relayVersion:'test'});
  assert.equal(android.deviceType,'phone');assert.equal(android.osName,'Android 兼容环境');
  assert.deepEqual(normalizeAnalyticsEnvironment(android),{device:'mobile',browser:'Chrome',os:'Android'});
  const iphone=parseClientEnvironment({userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1',relayVersion:'test'});
  assert.equal(normalizeAnalyticsEnvironment(iphone).device,'mobile');assert.equal(normalizeAnalyticsEnvironment(iphone).os,'iOS');
  const ipad=parseClientEnvironment({userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/18.0 Safari/605.1.15',navigatorPlatform:'MacIntel',maxTouchPoints:5,relayVersion:'test'});
  assert.equal(normalizeAnalyticsEnvironment(ipad).device,'tablet');assert.equal(normalizeAnalyticsEnvironment(ipad).os,'iPadOS');
  assert.equal(normalizeAnalyticsEnvironment({deviceType:'phone',osName:'HarmonyOS'}).os,'HarmonyOS');
});

test('公共消息环境解析的系统和浏览器分类完整投影到埋点',()=>{
  const cases=[
    ['Mozilla/5.0 (Phone; OpenHarmony 6.0; Android 10) Chrome/132.0 Mobile HuaweiBrowser/5.1','HarmonyOS','Huawei'],
    ['Mozilla/5.0 (Linux; Android 14; HyperOS/2.0) Chrome/130.0 Mobile MiuiBrowser/18.0','HyperOS','Xiaomi'],
    ['Mozilla/5.0 (Linux; Android 13; MIUI/V14.0) Chrome/130.0 Mobile MiuiBrowser/18.0','MIUI','Xiaomi'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1 MicroMessenger/8.0','iOS','WeChat'],
    ['Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile MQQBrowser/15.8','Android','QQ'],
    ['Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile UCBrowser/17.2','Android','UC'],
    ['Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Quark/7.9','Android','Quark'],
    ['Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile SamsungBrowser/24.0','Android','Samsung'],
    ['Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile OPR/90.0','Android','Opera'],
  ];
  for(const [userAgent,os,browser] of cases){
    const result=normalizeAnalyticsEnvironment(parseClientEnvironment({userAgent,uaData:{brands:[{brand:'Google Chrome',version:'130'}]},relayVersion:'test'}));
    assert.equal(result.os,os,userAgent);assert.equal(result.browser,browser,userAgent);assert.equal(result.device,'mobile');
  }
});
test('Web/PWA来源和客户端版本随事件发送，仍不包含UA原文',async()=>{
  const sent=[],t=createTracker({enabled:()=>true,send:async body=>sent.push(JSON.parse(body)),meta:()=>({...meta(),clientSource:'pwa',clientVersion:'0.54.1'})});
  t.page('tools','route','guest');await t.flush();
  assert.equal(sent[0].events[0].clientSource,'pwa');assert.equal(sent[0].events[0].clientVersion,'0.54.1');
  assert.doesNotMatch(JSON.stringify(sent),/userAgent|Mozilla|deviceId|cookie/i);
});
test('页面重渲染不重复PV，切换账号丢弃旧队列，只发送白名单上下文',async()=>{
  const sent=[];
  const t=createTracker({enabled:()=>true,meta,uuid:randomUUID,send:async body=>sent.push(JSON.parse(body))});
  t.page('tools','route-a','guest');t.page('tools','route-a','guest');assert.equal(t.size(),1);
  t.track('tool_action',{toolId:'qr',action:'export_png',result:'success'});await t.flush();
  assert.equal(sent[0].events.length,2);assert.equal(sent[0].events[0].pageViewId,sent[0].events[1].pageViewId);
  assert.doesNotMatch(JSON.stringify(sent),/token|cookie|userId|username|text|path/);
  t.track('tool_open',{toolId:'json'});t.page('chat','route-b','member-id');await t.flush();
  assert.equal(sent[1].events.length,1);assert.equal(sent[1].events[0].page,'chat');
});

test('站内路由不会重复归为最初外部网站，身份变化或重渲染不伪造导航',async()=>{
  const sent=[],t=createTracker({enabled:()=>true,meta:()=>({...meta(),sourceType:'external',referrerHost:'search.example'}),send:async body=>sent.push(JSON.parse(body))});
  t.page('login','first','guest');t.page('login','first','guest');assert.equal(t.size(),1);await t.flush();
  assert.equal(sent[0].events[0].sourceType,'external');assert.equal(sent[0].events[0].referrerHost,'search.example');
  t.page('chat','first','user');await t.flush();assert.equal(sent[1].events[0].sourceType,'external');
  t.reset();t.page('chat','first','user');await t.flush();assert.equal(sent[2].events[0].sourceType,'external');
  t.page('tools','second','user');t.track('tool_open',{toolId:'json'});await t.flush();
  for(const e of sent[3].events){assert.equal(e.sourceType,'internal');assert.equal(e.referrerHost,null);}
  t.page('chat','first','user');await t.flush();assert.equal(sent[4].events[0].sourceType,'internal');
});
test('禁用采集不发请求，拥塞队列有上限，失败丢弃且可继续发送',async()=>{
  let enabled=false,calls=0,release;
  const first=new Promise(resolve=>{release=resolve;});
  const t=createTracker({enabled:()=>enabled,meta,send:async()=>{calls++;if(calls===1)await first;throw Error('offline');}});
  t.track('tool_open',{toolId:'qr'});assert.equal(t.size(),0);
  enabled=true;
  for(let i=0;i<100;i++)t.track('tool_open',{toolId:'qr'});
  assert.equal(t.size(),50);release();await new Promise(resolve=>setTimeout(resolve,0));
  await t.flush();assert.equal(t.size(),30);assert.equal(calls,2);
  enabled=false;await t.flush();assert.equal(t.size(),0);
});

test('异步操作持有的上下文在换页和账号重置后失效',()=>{
  const t=createTracker({enabled:()=>true,meta,send:async()=>{}});
  t.page('tools','a','guest');const first=t.capture();assert.equal(first(),true);
  t.page('tools','a','guest');assert.equal(first(),true,'ordinary re-render preserves context');
  t.page('news','b','guest');assert.equal(first(),false);
  const second=t.capture();t.reset();assert.equal(second(),false);
  t.page('tools','c','user-1');const third=t.capture();t.page('tools','c','user-2');assert.equal(third(),false);
});
