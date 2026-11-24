import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { dailySeries,sortedTools,beijingDay,beijingTime,resultTone,analyticsSourceName,analyticsName } from './analytics-presentation.ts';
import { loadTsxForTest } from '../ui/tsx-test-helper.mjs';

const {default:DailyVisitsChart}=await loadTsxForTest(new URL('./DailyVisitsChart.tsx',import.meta.url).href);
const {ToolsRanking,Ranking,RecentVisits}=await loadTsxForTest(new URL('./AnalyticsSections.tsx',import.meta.url).href);
const render=(component,props)=>renderToStaticMarkup(React.createElement(component,props));
const now=Date.parse('2026-11-17T16:01:00Z'),since=Date.parse('2026-11-15T16:00:00Z');

test('飞书管理和历史未识别事件显示对应页面名称',()=>{
  assert.equal(analyticsName('feishu_bots'),'飞书管理');
  assert.equal(analyticsName('unknown'),'未识别');
});

test('补录提示仅在带标记的访问详情显示，帮助按钮不放入展开触发器',()=>{
  const row={id:'filled',at:now,name:'page_view',page:'tools',role:'guest',ip:null,device:'desktop',browser:'Edge',os:'Windows',source:null,result:null,siteId:null};
  const props={rows:[row],range:'7d',loading:false,error:null,retry:()=>{}};
  assert.doesNotMatch(render(RecentVisits,props),/已补录/);
  const html=render(RecentVisits,{...props,rows:[{...row,backfilled:true}]});
  assert.match(html,/已补录/);assert.match(html,/并非原始采集值/);
  for(const summary of html.match(/<summary>[\s\S]*?<\/summary>/g)??[])assert.doesNotMatch(summary,/<button/);
  assert.match(html,/aria-label="最近访问说明"/);assert.match(html,/aria-label="前端版本说明"/);
});

test('所有时间明细保留历史IP与来源网络，趋势仅展示最近30天而非删除历史',()=>{
  const row={id:'old',at:now-60*86400000,name:'page_view',page:'tools',role:'guest',ip:'192.168.1.2',device:'desktop',browser:'Edge',os:'Windows',source:null,result:null,siteId:null,networkType:'internal'};
  const html=render(RecentVisits,{rows:[row],range:'all',loading:false,error:null,retry:()=>{}});
  assert.match(html,/所有时间/);assert.match(html,/192.168.1.2/);assert.match(html,/本机 \/ 内网/);assert.doesNotMatch(html,/保留期限|仅今天或近 7 天/);
  const days=dailySeries([],row.at,row.at,now);assert.equal(days.length,30);assert.equal(days.at(-1).day,beijingDay(now));
});

test('日期按北京时间跨日，早于保留范围未知、范围内无记录为零，最多30天',()=>{
  assert.equal(beijingDay(now),'2026-11-18');
  const rows=dailySeries([{day:'2026-11-17',pv:9,uv:3}],since,Date.parse('2026-11-17T01:00Z'),now);
  assert.deepEqual(rows,[{day:'2026-11-16',pv:0,uv:0,available:false},{day:'2026-11-17',pv:9,uv:3,available:true},{day:'2026-11-18',pv:0,uv:0,available:true}]);
  assert.equal(dailySeries([],since,null,now).every(row=>!row.available),true);
  assert.equal(dailySeries([],now-60*86400000,now-60*86400000,now).length,30);
  assert.equal(beijingTime(now).includes('00:01:00'),true);
});
test('工具分别按操作/打开排序，不修改响应数据；输入无效不视为系统故障',()=>{
  const rows=[{label:'qr',opens:2,actions:30},{label:'json',opens:10,actions:1}];
  assert.deepEqual(sortedTools(rows,'opens').map(r=>r.label),['json','qr']);
  assert.deepEqual(sortedTools(rows,'actions').map(r=>r.label),['qr','json']);
  assert.equal(rows[0].label,'qr');assert.equal(resultTone('invalid_input'),'warning');assert.equal(resultTone('error'),'danger');
  const html=render(ToolsRanking,{rows});assert.ok(html.indexOf('二维码')<html.indexOf('JSON格式化'));assert.match(html,/按操作/);
});
test('图表日期可聚焦操作，未知日期不伪称零，原始标签转义',()=>{
  const html=render(DailyVisitsChart,{daily:[{day:'2026-11-17',pv:9,uv:3}],since,earliest:Date.parse('2026-11-17T01:00Z'),now});
  assert.match(html,/<button[^>]*aria-label="2026-11-16：无保留记录"/);
  assert.match(html,/aria-label="2026-11-17：9次访问，3个估算访客"/);
  assert.match(html,/aria-pressed="true"/);assert.doesNotMatch(html,/title=/);
  const ranking=render(Ranking,{title:'来源',rows:[{label:'<script>bad()</script>',count:1}],raw:true});
  assert.doesNotMatch(ranking,/<script>/);assert.match(ranking,/&lt;script&gt;/);
});

test('趋势区分零访问与无保留记录，提供每日表格及今日未结束说明',()=>{
 const html=render(DailyVisitsChart,{daily:[],since,earliest:since,now});
 assert.match(html,/data-available="true" style="height:0%"/);
 assert.match(html,/查看每日数据表/);assert.match(html,/今日未结束/);
 const unknown=render(DailyVisitsChart,{daily:[],since,earliest:null,now});
 assert.match(unknown,/data-available="false" style="height:2px"/);
});
test('最近访问只显示日期范围，时间值仍按北京时间，双端保留结果和IP',()=>{
  const html=render(RecentVisits,{rows:[{id:'1',at:now,name:'login_result',page:'login',role:'guest',ip:'203.0.113.1',device:'mobile',browser:'Safari',os:'iOS',source:null,result:'rejected',siteId:null,clientSource:'pwa',clientVersion:'0.54.1',serverVersion:'0.54.2'}],range:'7d',loading:false,error:null,retry:()=>{}});
  assert.match(html,/近 7 天/);assert.doesNotMatch(html,/北京时间/);assert.match(html,/analytics-visits-table/);assert.match(html,/analytics-visit-cards/);assert.match(html,/00:01:00/);assert.match(html,/登录被拒绝/);assert.match(html,/203.0.113.1/);
  const mobile=html.slice(html.indexOf('<ul class="analytics-visit-cards"'));
  assert.match(mobile,/Safari/);assert.match(mobile,/iOS/);
  assert.match(mobile,/PWA/);assert.match(mobile,/v0.54.1/);assert.match(mobile,/服务端版本<\/dt><dd>0.54.2/);
  assert.match(html,/>访问环境<\/th>/);assert.doesNotMatch(html,/>客户端<\/th>/);
  assert.match(html,/<colgroup>/);assert.equal((html.match(/<col style=/g)??[]).length,6);
});

test('筛选等待时最近访问仍展示旧记录，并明确提醒不是新筛选结果',()=>{
  const row={id:'1',at:now,name:'page_view',page:'tools',role:'guest',ip:'203.0.113.1',device:'desktop',browser:'Edge',os:'Windows',source:null,result:null,siteId:null};
  const html=render(RecentVisits,{rows:[row],range:'7d',loading:true,error:null,retry:()=>{},stale:true});
  assert.match(html,/暂显示上次访问记录/);assert.match(html,/203.0.113.1/);assert.match(html,/aria-busy="true"/);assert.doesNotMatch(html,/不适用/);
});

test('上次空访问结果在刷新或新筛选等待期间仍占位，不误称新筛选为空',()=>{
  const base={rows:[],range:'7d',loading:true,error:null,retry:()=>{}};
  const refresh=render(RecentVisits,base);
  assert.match(refresh,/analytics-empty/);assert.match(refresh,/当前筛选下暂无访问记录/);
  const filtering=render(RecentVisits,{...base,stale:true});
  assert.match(filtering,/analytics-empty/);assert.match(filtering,/上次筛选暂无访问记录/);assert.doesNotMatch(filtering,/当前筛选下暂无访问记录/);
  const failed=render(RecentVisits,{...base,stale:true,loading:false,error:Error('offline')});
  assert.match(failed,/上次筛选暂无访问记录/);assert.match(failed,/暂显示上次访问记录/);
  const initial=render(RecentVisits,{...base,rows:null});assert.doesNotMatch(initial,/analytics-empty/);
});
test('未识别设备和无外部来源明确标注，不把请求事件无结果等同失败',()=>{
  assert.equal(analyticsName('unknown'),'未识别');
  assert.equal(analyticsSourceName('直接或未知'),'未记录');
  assert.equal(analyticsSourceName('none'),'无来源信息');assert.equal(analyticsSourceName('internal'),'站内访问');assert.equal(analyticsSourceName('external:example.com'),'example.com');
  assert.equal(analyticsSourceName('example.com'),'example.com');
  const base={id:'1',at:now,name:'page_view',page:'tools',role:'guest',ip:null,device:'mobile',browser:'Chrome',os:'Android',source:null,result:null,siteId:null};
  const html=render(RecentVisits,{rows:[base],range:'7d',loading:false,error:null,retry:()=>{}});
  assert.doesNotMatch(html,/不适用/);assert.doesNotMatch(html,/处理错误/);
  const mobile=html.slice(html.indexOf('<ul class="analytics-visit-cards"'));
  assert.doesNotMatch(mobile,/不适用/);
  const missing=render(RecentVisits,{rows:[{...base,name:'login_result'}],range:'7d',loading:false,error:null,retry:()=>{}});
  assert.match(missing,/未记录/);assert.doesNotMatch(missing,/不适用/);
});
test('访问详情默认折叠，保留来源和版本；旧缺失值不伪称Web',()=>{
  const row={id:'1',at:now,name:'page_view',page:'tools',role:'guest',ip:null,device:'unknown',browser:'Other',os:'Other',source:'example.com',result:null,siteId:null,serverVersion:'0.54.2',accessHost:'relay.example',accessType:'domain'};
  const html=render(RecentVisits,{rows:[row],range:'7d',loading:false,error:null,retry:()=>{}});
  assert.match(html,/<details class="analytics-visit-details"><summary>/);
  assert.doesNotMatch(html,/<details[^>]* open/);
  assert.match(html,/example.com/);assert.match(html,/服务端版本<\/dt><dd>0.54.2/);
  assert.match(html,/访问主机<\/dt><dd>relay.example/);assert.match(html,/域名访问/);
  assert.match(html,/访问环境未记录/);assert.doesNotMatch(html,/>Web</);assert.doesNotMatch(html,/>PWA</);
});

test('详情区分来源无信息与未记录，已知外部域名不被状态字段掩盖',()=>{
  const base={id:'source',at:now,name:'page_view',page:'tools',role:'guest',ip:null,device:'desktop',browser:'Edge',os:'Windows',source:null,result:null,siteId:null};
  const show=row=>render(RecentVisits,{rows:[row],range:'7d',loading:false,error:null,retry:()=>{}});
  assert.match(show({...base,sourceType:'none'}),/页面来源<\/dt><dd>无来源信息/);
  assert.match(show({...base,sourceType:'internal'}),/页面来源<\/dt><dd>站内访问/);
  assert.match(show(base),/页面来源<\/dt><dd>未记录/);
  assert.match(show({...base,source:'outside.example'}),/外部网站：outside.example/);
});

test('托管前端版本来自网关，历史缺失不再显示不适用或从服务端代填',()=>{
  const row={id:'hosting',at:now,name:'hosting_document',page:'hosting',role:'guest',ip:null,device:'desktop',browser:'Edge',os:'Windows',source:null,result:null,siteId:'site',serverVersion:'0.54.1'};
  const html=render(RecentVisits,{rows:[row],range:'7d',loading:false,error:null,retry:()=>{}});
  assert.match(html,/前端类型<\/dt><dd>未记录/);
  assert.match(html,/前端版本<button[^]*?<\/dt><dd>未记录/);
  assert.match(html,/服务端版本<\/dt><dd>0.54.1/);
  assert.doesNotMatch(html,/前端版本<button[^]*?<\/button><\/dt><dd>0.54.1/);
  assert.doesNotMatch(html,/不适用（托管页面）/);
  const modern=render(RecentVisits,{rows:[{...row,clientSource:'gateway',clientVersion:'0.53.0'}],range:'7d',loading:false,error:null,retry:()=>{}});
  assert.match(modern,/前端类型<\/dt><dd>前端网关/);assert.match(modern,/前端版本<button[^]*?<\/dt><dd>0.53.0/);assert.match(modern,/v0.53.0/);
});
