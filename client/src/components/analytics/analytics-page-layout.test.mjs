import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsxForTest} from '../ui/tsx-test-helper.mjs';

const summaries={since:Date.now()-86400000,earliest:Date.now()-86400000,totals:{pv:7,uv:2,users:1,actions:99,news:0,hosting:0,logins:0},daily:[],pages:[],tools:[],results:[],sources:[],devices:[],loginResults:[],hosting:[]};
globalThis.__analyticsFixtures={summary:summaries,features:{features:[{feature:'settings',views:2,actions:3,failures:2,results:{error:1,cancelled:2}}],operations:[{registrationId:'settings.save',feature:'settings',action:'save',count:3}]},quality:{server:{startedAt:Date.now(),queueDropped:0,writeFailed:0,observationsDropped:0,validationRejected:0,rateLimited:0}},visits:[]};
const stubs=new Map([
 [new URL('../../auth/AuthContext.tsx',import.meta.url).href,'export const useAuth=()=>({user:{id:"test-admin",role:"admin"}});'],
 [new URL('./analytics.css',import.meta.url).href,'export {};'],
 [new URL('./AnalyticsHelp.tsx',import.meta.url).href,'export const analyticsHelp={};export default function Help(){return null;}'],
 [new URL('./useAnalyticsResource.ts',import.meta.url).href,`export function useAnalyticsResource(path){const key=path?.split('/').pop().split('?')[0];return{data:path?globalThis.__analyticsFixtures[key]:null,loading:false,error:null,stale:false,updatedAt:1000,cached:false,retry:()=>{},dataPath:path,...globalThis.__analyticsResourceOverrides?.[key]};}`],
]);
const {default:Page}=await loadTsxForTest(new URL('./AnalyticsPage.tsx',import.meta.url).href,stubs);
const {default:ResourceState}=await loadTsxForTest(new URL('./AnalyticsResourceState.tsx',import.meta.url).href,stubs);
test('核心指标与全平台功能前移，历史口径独立收起，桌面/移动使用对应布局',()=>{
 const html=renderToStaticMarkup(React.createElement(Page));
 assert.ok(html.indexOf('全平台功能')<html.indexOf('访问来源与使用环境'));
 assert.match(html,/明确操作/);assert.match(html,/处理失败记录/);assert.match(html,/仅 error|不含取消、拒绝与系统事件/);
 assert.match(html,/analytics-feature-table/);assert.match(html,/analytics-feature-cards/);assert.match(html,/操作与结果明细/);assert.match(html,/统计采集状态/);
 assert.match(html,/本地操作失败/);
 assert.doesNotMatch(html.slice(html.indexOf('analytics-metrics'),html.indexOf('analytics-overview-grid')),/analytics-update-status/,'健康汇总不重复占用独立状态行');
 assert.doesNotMatch(html,/window.location.reload/);
});

test('筛选读取保留指标和趋势，不在两者之间插入临时状态块',t=>{
 const ready=renderToStaticMarkup(React.createElement(Page));
 globalThis.__analyticsResourceOverrides={summary:{loading:true,stale:true},features:{loading:true,stale:true},visits:{loading:true,stale:true}};
 t.after(()=>delete globalThis.__analyticsResourceOverrides);
 const loading=renderToStaticMarkup(React.createElement(Page));
 for(const html of [ready,loading]){
  assert.doesNotMatch(html.slice(html.indexOf('analytics-metrics'),html.indexOf('analytics-overview-grid')),/analytics-update-status/);
  assert.equal((html.match(/class="analytics-module-label"/g)??[]).length,4);
  assert.equal((html.match(/class="analytics-module-time"/g)??[]).length,4);
  assert.match(html,/analytics-overview-grid/);assert.match(html,/>7<\/strong>/);
 }
 assert.match(loading,/上次筛选/);
 assert.match(loading,/<span aria-hidden="false">暂显示上次筛选结果<\/span>/);
});

test('失败保留旧结果时只显示一次旧数据说明，状态行保留快照时间',()=>{
 const html=renderToStaticMarkup(React.createElement(ResourceState,{label:'访问汇总',resource:{data:{},loading:false,stale:true,error:Error('offline'),updatedAt:1000,cached:true,retry:()=>{}}}));
 assert.match(html,/更新未完成，以下保留上次成功读取的数据/);
 assert.match(html,/重新读取/);
 const visible=Array.from(html.matchAll(/<span(?: class="[^"]*")? aria-hidden="false">([^<]*)<\/span>/g),match=>match[1]).join('');
 assert.match(visible,/数据截至/);assert.match(visible,/缓存快照/);
 assert.doesNotMatch(visible,/暂显示上次结果/);
});
