import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { formatDateTime } from '../../utils/date-display.ts';
import {isSuccessfulDashboardRefresh,isSuccessfulResponsibilityRefresh,latestFeishuTaskUpdatedAt,readWorkspaceRefreshTimes,rememberWorkspaceRefreshTime,trackSuccessfulWorkspaceRefresh} from './workspace-source-times.ts';

const componentUrl = new URL('./WorkspaceSourceTimes.tsx', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url !== componentUrl) return nextLoad(url, context);
    return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(fs.readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
      }).outputText };
  },
});
let WorkspaceSourceTimes;
try { ({ default: WorkspaceSourceTimes } = await import(componentUrl)); }
finally { hooks.deregister(); }

const generatedAt = '2026-11-15T17:53:00+08:00';
const success = Date.parse('2026-11-16T11:26:00+08:00');
const attempt = success + 60_000;
const time = (value) => formatDateTime(value);
const refreshValueStart = '<dt>刷新成功</dt><dd class="workspace-workbench__source-refresh-row"><span>';
const render = (props) => renderToStaticMarkup(React.createElement(WorkspaceSourceTimes, {
  dashboard: null, responsibility: null, localFailed: false, projectFailed: false,
  onDismissRefresh: () => {}, ...props,
}));
const loadingActivity = { pending: 1, startedAt: performance.now(), finishedAt: null, dismissed: false, succeeded: false };
const completedActivity = { ...loadingActivity, pending: 0, startedAt: 1000, finishedAt: 4600, succeeded: true };

test('旧数据重新获取成功时，数据时间与最后成功刷新时间分别显示；缓存读取不改时间', () => {
  const dashboard = { registryGeneratedAt: generatedAt, capturedAt: attempt,
    sourceMeta: { state: 'snapshot', lastSuccessAt: success, lastAttemptAt: null } };
  const html = render({ dashboard });
  assert.match(html, new RegExp(`<dt>台账生成</dt><dd>${time(generatedAt)}</dd>`));
  assert.match(html, new RegExp(`${refreshValueStart}${time(success)}</span></dd>`));
  assert.doesNotMatch(html, /aria-label="台账刷新成功"|关闭台账刷新提示/);
  assert.doesNotMatch(html, new RegExp(time(attempt)));
  assert.match(html, /aria-label="台账时间"/);
  assert.match(html, /aria-label="飞书时间"/);
});

test('飞书刷新失败时保留成功时间，独立标记最近失败尝试', () => {
  const html = render({ projectFailed: true, responsibility: { generatedAt, fetchedAt: attempt,
    sourceMeta: { state: 'failed_snapshot', lastSuccessAt: success, lastAttemptAt: attempt } } });
  assert.match(html, new RegExp(`${refreshValueStart}${time(success)}</span></dd>`));
  assert.match(html, new RegExp(`${time(attempt)} · 失败`));
});

test('首次失败不将本次采集时间冒充成功刷新；兼容旧接口且不渲染无效日期', () => {
  const failed = render({ localFailed: true, dashboard: { capturedAt: attempt,
    sourceMeta: { state: 'unavailable', lastSuccessAt: null, lastAttemptAt: attempt } } });
  assert.match(failed, new RegExp(`${refreshValueStart}尚未成功刷新</span>`));
  const legacy = render({ dashboard: { registryGeneratedAt: 'bad', capturedAt: success },
    responsibility: { generatedAt, fetchedAt: success } });
  assert.equal((legacy.match(new RegExp(time(success), 'g')) ?? []).length, 2);
  assert.doesNotMatch(legacy, /Invalid Date|1970/);
  for (const value of [0, null, '', 'bad']) {
    const missing = render({ dashboard: { registryGeneratedAt: value, capturedAt: value } });
    assert.doesNotMatch(missing, /Invalid Date|1970|未记录/);
    assert.match(missing, /尚未成功刷新/);
  }
  assert.equal(render({}), '');
});

test('请求直接失败时不将保留快照的旧成功或失败时间标作本次失败时间', () => {
  for (const state of ['live', 'failed_snapshot']) {
    const html = render({ localFailed: true, localRequestFailed: true,
      dashboard: { registryGeneratedAt: generatedAt, capturedAt: success,
        sourceMeta: { state, lastSuccessAt: success, lastAttemptAt: attempt } } });
    assert.match(html, new RegExp(`${refreshValueStart}${time(success)}</span></dd>`));
    assert.match(html, /最近尝试<\/dt><dd class="text-amber-300">失败<\/dd>/);
    assert.doesNotMatch(html, new RegExp(`${time(attempt)} · 失败`));
  }
});

test('两路首次请求都失败仍显示未成功刷新及失败提示', () => {
  const html = render({ localFailed: true, projectFailed: true, localRequestFailed: true, projectRequestFailed: true });
  assert.equal((html.match(/尚未成功刷新/g) ?? []).length, 2);
  assert.equal((html.match(/>失败<\/dd>/g) ?? []).length, 2);
});

test('本地部分来源首次不可用也标记失败，不被台账主体可用状态掩盖', () => {
  const html = render({ dashboard: { capturedAt: attempt,
    sourceMeta: { state: 'unavailable', lastSuccessAt: null, lastAttemptAt: attempt } } });
  assert.match(html, /尚未成功刷新/);
  assert.match(html, new RegExp(`${time(attempt)} · 失败`));
});

test('飞书数据时间取完整报表中任务和子任务的最新更新时间，不取采集时间',()=>{
 const older='2026-11-19T12:00:00+08:00',latest='2026-11-20T20:00:00+08:00';
 const responsibility={generatedAt:'2026-11-20T21:00:00+08:00',fetchedAt:Date.parse('2026-11-20T21:00:00+08:00'),items:[{workItemId:'1',updatedAt:older}],workbenchItems:[{workItemId:'1',updatedAt:'2026-11-20T11:00:00+08:00',mySubtasks:[]},{workItemId:'hidden',participated:false,updatedAt:older,mySubtasks:[{updatedAt:latest}]}]};
 assert.equal(latestFeishuTaskUpdatedAt(responsibility),Date.parse(latest));
 const html=render({responsibility});assert.match(html,new RegExp(`<dt>飞书更新</dt><dd>${time(latest)}</dd>`));
 assert.match(html,new RegExp(`${refreshValueStart}${time(responsibility.fetchedAt)}</span></dd>`));
 assert.doesNotMatch(html, /飞书刷新成功|关闭飞书刷新提示/);
 assert.equal(latestFeishuTaskUpdatedAt({...responsibility,items:[...responsibility.items].reverse(),workbenchItems:[...responsibility.workbenchItems].reverse()}),Date.parse(latest));
 const empty=render({responsibility:{generatedAt,fetchedAt:success,items:[{updatedAt:'bad',createdAt:latest}],workbenchItems:[]}});
 assert.match(empty,/<dt>飞书更新<\/dt><dd>未提供<\/dd>/);
});

test('台账与飞书各自显示加载圆环，成功的来源先显示对号，失败保留上次时间', () => {
  const loading = render({ localActivity: loadingActivity, projectActivity: loadingActivity });
  assert.match(loading, /尚未成功刷新<\/span><span[^>]*><svg[^>]*aria-label="台账刷新中"[^>]*animate-spin/);
  assert.match(loading, /尚未成功刷新<\/span><span[^>]*><svg[^>]*aria-label="飞书刷新中"[^>]*animate-spin/);

  const dashboard = { capturedAt: success };
  const responsibility = { fetchedAt: success };
  const mixed = render({ dashboard, responsibility, localActivity: completedActivity, projectActivity: loadingActivity });
  assert.match(mixed, new RegExp(`${refreshValueStart}${time(success)}</span><span[^>]*><svg[^>]*aria-label="台账刷新成功"`));
  assert.match(mixed, new RegExp(`${refreshValueStart}${time(success)}</span><span[^>]*><svg[^>]*aria-label="飞书刷新中"`));
  assert.doesNotMatch(mixed, /台账刷新中|飞书刷新成功/);

  const failed = render({ dashboard, responsibility, localPartial: true, projectFailed: true });
  assert.equal((failed.match(new RegExp(`${refreshValueStart}${time(success)}</span></dd>`, 'g')) ?? []).length, 2);
  assert.doesNotMatch(failed, /aria-label="(?:台账|飞书)刷新(?:中|成功)"/);
  assert.match(failed, /最近尝试<\/dt><dd class="text-amber-300">失败<\/dd>/);
});

test('耗时紧跟状态图标，每个来源可以独立关闭且保留最后刷新时间', () => {
  const props = { dashboard: { capturedAt: success }, responsibility: { fetchedAt: success }, localActivity: completedActivity, projectActivity: loadingActivity };
  const html = render(props);
  assert.match(html, /台账刷新成功[^>]*><path[^>]*><\/path><\/svg><span>耗时 3 秒<\/span><button[^>]*aria-label="关闭台账刷新提示"/);
  assert.match(html, /飞书刷新中[^>]*>.*?<\/svg><span>耗时 \d+ 秒<\/span><button[^>]*aria-label="关闭飞书刷新提示"/);
  assert.doesNotMatch(html, /已耗时|耗时 \d+\.\d/);
  for (const projectActivity of [loadingActivity, completedActivity]) {
    const dismissed = render({ ...props, projectActivity: { ...projectActivity, dismissed: true } });
    assert.match(dismissed, new RegExp(`${refreshValueStart}${time(success)}</span></dd>`));
    assert.match(dismissed, /关闭台账刷新提示/);
    assert.doesNotMatch(dismissed, /飞书刷新中|飞书刷新成功|关闭飞书刷新提示/);
  }
});

test('飞书缓存响应保持上次成功时间，只有实际拉取成功才能推进', async () => {
  const live = { servedFromCache: false, stale: false, error: null, sourceMeta: { state: 'live' } };
  const cached = { ...live, servedFromCache: true };
  const snapshot = { ...live, sourceMeta: { state: 'snapshot' } };
  const failed = { ...live, stale: true, error: '刷新失败', sourceMeta: { state: 'failed_snapshot' } };
  let lastRefresh = success;
  for (const [value, force] of [[cached, false], [cached, true], [snapshot, true], [failed, true]]) {
    await trackSuccessfulWorkspaceRefresh(async () => value, result => isSuccessfulResponsibilityRefresh(result, force),
      at => { lastRefresh = at; }, () => attempt);
  }
  assert.equal(lastRefresh, success);
  await trackSuccessfulWorkspaceRefresh(async () => live, isSuccessfulResponsibilityRefresh,
    at => { lastRefresh = at; }, () => attempt);
  assert.equal(lastRefresh, attempt);
});

test('台账刷新只记录成功实时结果，兼容没有来源元数据的旧接口', () => {
  assert.equal(isSuccessfulDashboardRefresh({ errors: [], sourceMeta: { state: 'live' } }), true);
  assert.equal(isSuccessfulDashboardRefresh({ errors: [], sourceMeta: { state: 'snapshot' } }, true), false);
  assert.equal(isSuccessfulDashboardRefresh({ errors: ['部分失败'], sourceMeta: { state: 'live' } }, true), false);
  assert.equal(isSuccessfulDashboardRefresh({ errors: [] }), false);
  assert.equal(isSuccessfulDashboardRefresh({ errors: [] }, true), true);
});

test('成功刷新记录完成时间，失败和缓存读取均不推进，乱序成功不回退时间',async()=>{
 const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
 const record=at=>rememberWorkspaceRefreshTime(storage,'user','project',at);
 let timestamp=success-1000;
 await trackSuccessfulWorkspaceRefresh(async()=>{timestamp=success;return {ok:true};},value=>value.ok,record,()=>timestamp);
 assert.equal(readWorkspaceRefreshTimes(storage,'user').project,success);
 await trackSuccessfulWorkspaceRefresh(async()=>({ok:false}),value=>value.ok,record,()=>attempt);
 await assert.rejects(trackSuccessfulWorkspaceRefresh(async()=>{throw Error('network');},()=>true,record,()=>attempt));
 await trackSuccessfulWorkspaceRefresh(async()=>({cached:true}),value=>!value.cached,record,()=>attempt);
 assert.equal(readWorkspaceRefreshTimes(storage,'user').project,success);
 record(attempt);record(success);assert.equal(readWorkspaceRefreshTimes(storage,'user').project,attempt);
 assert.equal(readWorkspaceRefreshTimes(storage,'other-user').project,null);
 const html=render({responsibility:{generatedAt,fetchedAt:attempt,items:[],workbenchItems:[],sourceMeta:{state:'failed_snapshot',lastSuccessAt:success,lastAttemptAt:attempt}},projectRefreshAt:success-60_000,projectFailed:true});
 assert.match(html,new RegExp(`${refreshValueStart}${time(success)}</span></dd>`));
 assert.match(html,new RegExp(`${time(attempt)} · 失败`));
 const unavailable={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
 assert.equal(rememberWorkspaceRefreshTime(unavailable,'user','local',success).local,success);
});
