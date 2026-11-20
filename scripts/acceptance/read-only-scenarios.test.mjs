import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { PageSession } from './lib/page-session.mjs';
import { runReadOnlyAcceptance } from './lib/read-only-scenarios.mjs';

function createFakeCdp({ autoLoadOnReload = true } = {}) {
  const calls = [];
  const listeners = new Map();
  return {
    calls, listeners,
    on(method, listener) { listeners.set(method, listener); return this; },
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') return { result: { value: { ready: true } } };
      if (method === 'Network.setCookie') return { success: true };
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('png').toString('base64') };
      if (method === 'Page.reload' && autoLoadOnReload) queueMicrotask(() => listeners.get('Page.loadEventFired')?.({}));
      return {};
    },
  };
}

test('工作台固定场景只读打开各列表和详情，复用同一浏览器与清理机制',async()=>{
 const calls=[],shots=[];
 const page={enableMonitoring:async()=>{},injectRelaySession:async()=>{},navigate:async url=>calls.push(['navigate',url]),setViewport:async()=>{},
  waitForStable:async()=>({buildId:'abcdef123456',protocolVersion:23}),waitForWorkbench:async()=>{},captureScreenshot:async file=>shots.push(file),
  readWorkbenchLayout:async()=>({overflow:false,drawerOverflow:false,cardOverflow:0}),showWorkbenchLane:async lane=>calls.push(['lane',lane]),
  openWorkbenchDetail:async kind=>kind!=='project',closeWorkbenchDetail:async()=>calls.push(['close']),showWorkbenchRecords:async()=>calls.push(['records']),
  getEvidence:()=>({exceptions:[],httpErrors:[],logErrors:[],webSockets:{created:0,closed:0,reconnects:0}})};
 let cleanups=0;
 const result=await runReadOnlyAcceptance({config:{origin:'http://localhost:9081',desktopViewport:{width:1456,height:819,deviceScaleFactor:1},mobileViewport:{width:390,height:844,deviceScaleFactor:1},timeouts:{}},
  cookieValue:'test-cookie',workbench:true,launchRuntime:async()=>({runId:'test',runDir:'.relay-dev/test'}),connectPage:async()=>({page,browserCdp:{}}),
  cleanupRuntime:async()=>{cleanups++;return{process:'cleaned',port:'released',profile:'removed'};},finalizeState:()=>{},writeReport:()=>{}});
 assert.equal(result.status,'passed');assert.equal(cleanups,1);assert.deepEqual(result.scenarios.map(item=>item.id),['workbench-desktop','workbench-mobile']);
 assert(calls.some(call=>call[0]==='navigate'&&call[1].endsWith('/admin/task-workbench')));
 assert.deepEqual(calls.filter(call=>call[0]==='lane').map(call=>call[1]),['unstarted','unstarted','doing','completed']);
 assert.equal(shots.length,13);
 assert.deepEqual(result.scenarios[0].snapshot.detailSamples.map(sample=>sample.kind),['group','project','tracking','run']);
 assert.equal(result.scenarios[0].snapshot.detailSamples.find(sample=>sample.kind==='project').status,'not_available');
});

test('workbench waits for both sources even when local task lanes already exist',async()=>{
 let samples=0;
 const page=new PageSession({async request(method,params){
   assert.equal(method,'Runtime.evaluate');samples++;
   const value=await runInNewContext(params.expression,{document:{body:{innerText:''},querySelector:selector=>selector.includes('task-lanes')?{}:samples<3?{}:null}});
   return{result:{value}};
 }});
 await page.waitForWorkbench();
 assert.equal(samples,3);
});

test('project detail sampling accepts native type names and never selects a local task action',async()=>{
 const clicks=[];
 const candidate=(id,labels)=>({closest:()=>({classList:{contains:()=>false},querySelectorAll:()=>labels.map(textContent=>({textContent}))}),getBoundingClientRect:()=>({width:100}),click:()=>clicks.push(id)});
 const document={querySelectorAll:()=>[candidate('local',['本地交付','飞书需求 · 11']),candidate('project',['飞书B端售后支持 · 22'])],
   querySelector:()=>clicks.length?{querySelectorAll:()=>[]}:null};
 const page=new PageSession({async request(method,params){assert.equal(method,'Runtime.evaluate');return{result:{value:await runInNewContext(params.expression,{document})}};}});
 assert.equal(await page.openWorkbenchDetail('project'),true);
 assert.deepEqual(clicks,['project']);
 await assert.rejects(page.openWorkbenchDetail('unknown'));
});

test('engine terminal inspection reads the public message-page envelope', async () => {
  const page = new PageSession({
    async request(method, params) {
      assert.equal(method, 'Runtime.evaluate');
      const value = await runInNewContext(params.expression, {
        fetch: async () => ({ ok: true, json: async () => ({ unchanged: false, page: { messages: [
          { role: 'user' }, { role: 'assistant', outcome: 'completed' },
        ] } }) }),
      });
      return { result: { value: JSON.parse(JSON.stringify(value)) } };
    },
  });
  const result = await page.waitForTerminal('synthetic');
  assert.deepEqual(result, { userCount: 1, assistantCount: 1, terminalCount: 1, outcome: 'completed', errorCode: null });
});

test('desktop stop clicks once without requiring the mobile confirmation dialog', async () => {
  let clicks = 0;
  const page = new PageSession({
    async request(method, params) {
      assert.equal(method, 'Runtime.evaluate');
      const value = await runInNewContext(params.expression, {
        window: { matchMedia: () => ({ matches: true }) },
        document: { querySelector: () => ({ click: () => { clicks++; } }) },
      });
      return { result: { value } };
    },
  });
  await page.stopGeneration();
  assert.equal(clicks, 1);
});

test('Cookie 注入严格早于第一次 Relay 导航', async () => {
  const cdp = createFakeCdp();
  const page = new PageSession(cdp);
  await page.enableMonitoring();
  await page.injectRelaySession({ origin: 'http://localhost:9081', cookieValue: 'cookie-value' });
  await page.navigate('http://localhost:9081');
  const cookieIndex = cdp.calls.findIndex((call) => call.method === 'Network.setCookie');
  const navigateIndex = cdp.calls.findIndex((call) => call.method === 'Page.navigate');
  assert.ok(cookieIndex >= 0 && cookieIndex < navigateIndex);
  assert.equal(cdp.calls[cookieIndex].params.name, 'relay_session');
});

test('监控 Runtime、Log、Network、Page 及 WebSocket 异常', async () => {
  const cdp = createFakeCdp();
  const page = new PageSession(cdp);
  await page.enableMonitoring();
  for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) assert.ok(cdp.calls.some((call) => call.method === method));
  cdp.listeners.get('Runtime.exceptionThrown')?.({ exceptionDetails: { text: 'boom' } });
  cdp.listeners.get('Network.responseReceived')?.({ response: { status: 500, url: 'http://localhost:9181/api/test' } });
  cdp.listeners.get('Network.webSocketCreated')?.({ requestId: 'ws-1', url: 'ws://localhost:9181/ws' });
  cdp.listeners.get('Network.webSocketClosed')?.({ requestId: 'ws-1' });
  cdp.listeners.get('Network.webSocketCreated')?.({ requestId: 'ws-2', url: 'ws://localhost:9181/ws' });
  const evidence = page.getEvidence();
  assert.equal(evidence.exceptions.length, 1);
  assert.equal(evidence.httpErrors.length, 1);
  assert.equal(evidence.webSockets.created, 2);
  assert.equal(evidence.webSockets.closed, 1);
  assert.equal(evidence.webSockets.reconnects, 1);
});

test('只读稳定态等待 Build ID 与 WebSocket 协议元数据到齐', async () => {
  const cdp = createFakeCdp();
  let snapshotCount = 0;
  const page = new PageSession(cdp, {
    snapshot: async () => ({
      ready: true,
      authenticated: true,
      buildId: 'abcdef123456',
      protocolVersion: ++snapshotCount >= 3 ? 23 : null,
    }),
  });

  const snapshot = await page.waitForStable({ timeoutMs: 1000, pollMs: 0, requireMetadata: true });

  assert.equal(snapshot.protocolVersion, 23);
  assert.equal(snapshotCount, 6);
});

test('只读稳定态遇到延迟挂载的骨架屏时重新累计连续稳定采样', async () => {
  const cdp = createFakeCdp();
  const states = [
    { ready: true, authenticated: true },
    { ready: false, authenticated: true },
    { ready: true, authenticated: true },
    { ready: true, authenticated: true },
    { ready: true, authenticated: true },
    { ready: true, authenticated: true },
  ];
  let snapshotCount = 0;
  const page = new PageSession(cdp, {
    snapshot: async () => ({
      ...states[Math.min(snapshotCount++, states.length - 1)],
      buildId: 'abcdef123456',
      protocolVersion: 26,
    }),
  });

  const snapshot = await page.waitForStable({ timeoutMs: 1000, pollMs: 0, requireMetadata: true });

  assert.equal(snapshot.ready, true);
  assert.equal(snapshotCount, 6);
});

test('页面快照把聊天、侧栏、标题、消息与恢复状态统一视为加载中', async () => {
  const cdp = createFakeCdp();
  const page = new PageSession(cdp);

  await page.readSnapshot();

  const expression = cdp.calls.find((call) => call.method === 'Runtime.evaluate')?.params.expression || '';
  for (const label of ['正在加载聊天界面', '正在加载项目和会话', '正在加载会话标题', '正在加载消息', '正在恢复会话位置']) {
    assert.match(expression, new RegExp(label, 'u'));
  }
});

test('页面刷新等待新文档 load 事件后才继续', async () => {
  const cdp = createFakeCdp({ autoLoadOnReload: false });
  const page = new PageSession(cdp);
  await page.enableMonitoring();
  let settled = false;

  const reload = page.reload({ timeoutMs: 1000, pollMs: 0 }).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  cdp.listeners.get('Page.loadEventFired')?.({});
  await reload;
  assert.equal(settled, true);
});

test('桌面和移动视口执行、刷新比较且每个视口最多两张 PNG', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-readonly-'));
  const runtime = { runId: 'run-test', runDir: root };
  const cdp = createFakeCdp();
  const page = new PageSession(cdp, { snapshot: async () => ({ ready: true, authenticated: true, sessions: ['session-a'], currentSession: 'a', protocolVersion: 23, buildId: 'abcdef123456' }) });
  const cleanupCalls = [];
  const finalizeCalls = [];
  let additionalCalled = false;
  const report = await runReadOnlyAcceptance({
    config: { origin: 'http://localhost:9081', desktopViewport: { width: 1456, height: 819, deviceScaleFactor: 1 }, mobileViewport: { width: 390, height: 844, deviceScaleFactor: 1 }, timeouts: { navigationMs: 1000, scenarioMs: 1000 } },
    cookieValue: 'cookie-value', launchRuntime: async () => runtime,
    connectPage: async () => ({ browserCdp: { closeBrowser: async () => {} }, page }),
    cleanupRuntime: async (value) => { cleanupCalls.push(value); return { process: 'cleaned', port: 'released', profile: 'removed' }; },
    finalizeState: (runtimeValue, cleanupValue) => { finalizeCalls.push({ runtime: runtimeValue, cleanup: cleanupValue }); },
    writeReport: ({ report: value }) => value,
    runAdditionalScenarios: async () => {
      additionalCalled = true;
      const viewport = cdp.calls.filter(call => call.method === 'Emulation.setDeviceMetricsOverride').at(-1);
      assert.equal(viewport.params.width, 1456);
      assert.equal(viewport.params.mobile, false);
      return [];
    },
  });
  assert.equal(additionalCalled, true);
  assert.equal(cleanupCalls.length, 1);
  assert.equal(finalizeCalls.length, 1);
  assert.deepEqual(finalizeCalls[0].cleanup, { process: 'cleaned', port: 'released', profile: 'removed' });
  assert.deepEqual(report.scenarios.map((item) => item.id), ['desktop', 'mobile']);
  assert.ok(cdp.calls.some((call) => call.method === 'Emulation.setDeviceMetricsOverride' && call.params.width === 1456));
  assert.ok(cdp.calls.some((call) => call.method === 'Emulation.setTouchEmulationEnabled' && call.params.enabled === true));
  assert.ok(cdp.calls.filter((call) => call.method === 'Page.reload').length >= 2);
  assert.ok(fs.readdirSync(path.join(root, 'screenshots')).filter((name) => name.endsWith('.png')).length <= 4);
  assert.ok(report.scenarios.every((item) => item.status === 'passed'));
});

test('任一阶段抛错仍执行 runtime cleanup', async () => {
  const cleanupCalls = [];
  const finalizeCalls = [];
  await assert.rejects(() => runReadOnlyAcceptance({
    config: { origin: 'http://localhost:9081', desktopViewport: {}, mobileViewport: {}, timeouts: {} }, cookieValue: 'cookie-value',
    launchRuntime: async () => ({ runId: 'run-test', runDir: 'unused' }), connectPage: async () => { throw new Error('connect failed'); },
    cleanupRuntime: async (value) => { cleanupCalls.push(value); return { process: 'remaining', port: 'listening', profile: 'remaining' }; },
    finalizeState: (runtimeValue, cleanupValue) => { finalizeCalls.push({ runtime: runtimeValue, cleanup: cleanupValue }); },
    writeReport: () => {},
  }), /connect failed/u);
  assert.equal(cleanupCalls.length, 1);
  assert.equal(finalizeCalls.length, 1);
  assert.deepEqual(finalizeCalls[0].cleanup, { process: 'remaining', port: 'listening', profile: 'remaining' });
});
