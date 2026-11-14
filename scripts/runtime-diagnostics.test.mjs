import test from 'node:test';
import assert from 'node:assert/strict';
import { collectWindowsPressure, createRuntimeDiagnostics, RUNTIME_DIAGNOSTICS_CHANNEL } from './lib/runtime-diagnostics.mjs';

const services = [{ id: 'backend', port: 9181, healthUrl: 'http://backend/health' },
  { id: 'frontend', port: 9081, healthUrl: 'http://frontend/status' },
  { id: 'codex', port: 9281, healthUrl: 'http://codex/readyz' }];
const flush = () => new Promise((resolve) => setImmediate(resolve));
function harness(overrides = {}) {
  const records = [];
  let time = 0;
  let osProbes = 0;
  const monitor = createRuntimeDiagnostics({
    services, now: () => time, clock: () => time,
    getState: () => ({ managed: true, pid: 123, alive: true, restarting: false }),
    fetch: async () => new Response('', { status: 200 }),
    write: (record) => records.push(record),
    collectPressure: async () => { osProbes++; return { status: 'ok', diskQueue: 0 }; },
    ...overrides,
  });
  return { monitor, records, advance: (ms) => { time += ms; }, osProbes: () => osProbes };
}

test('正常采样探测三个端点，空闲停止的 Codex 不被唤醒或误报', async () => {
  const urls = [];
  const h = harness({ getState: (id) => ({ managed: id !== 'codex', alive: id !== 'codex' }),
    fetch: async (url) => { urls.push(url); return new Response(''); } });
  await h.monitor.sample();
  assert.equal(urls.length, 2);
  assert.equal(h.records[0].services[2].status, 'not_managed');
  assert.equal(h.osProbes(), 0);
  h.monitor.stop();
});

test('后台消息按数字白名单投影，故障包含六条有界历史且 OS 采集冷却一分钟', async () => {
  const h = harness();
  for (let i = 0; i < 10; i++) { h.advance(10_000); await h.monitor.sample(); }
  h.monitor.handleBackendMessage({ channel: RUNTIME_DIAGNOSTICS_CHANNEL, type: 'fault', code: 'CODEX_CONNECTION_TIMEOUT',
    metrics: { eventLoopMaxMs: 1200, pid: 42, token: 'secret', rssMb: 'secret', heapUsedMb: Infinity } });
  await flush();
  const fault = h.records.find((r) => r.type === 'fault');
  assert.equal(fault.recent.length, 6);
  assert.equal(fault.backend.eventLoopMaxMs, 1200);
  assert.doesNotMatch(JSON.stringify(h.records), /secret|Infinity/);
  h.monitor.handleBackendMessage({ channel: RUNTIME_DIAGNOSTICS_CHANNEL, type: 'fault', code: 'CODEX_CONNECTION_TIMEOUT' });
  assert.equal(h.osProbes(), 1);
  h.advance(60_001);
  h.monitor.handleBackendMessage({ channel: RUNTIME_DIAGNOSTICS_CHANNEL, type: 'fault', code: 'CODEX_CONNECTION_TIMEOUT' });
  await flush();
  assert.equal(h.osProbes(), 2);
  h.monitor.stop();
});

test('服务无响应触发快照；失败正文和异常文本不进入日志', async () => {
  const h = harness({ fetch: async () => { throw new Error('token=secret C:/private'); } });
  await h.monitor.sample();
  await flush();
  assert.equal(h.records[0].services.every((s) => s.status === 'unreachable'), true);
  assert.equal(h.records[1].code, 'SERVICE_STALL');
  assert.equal(h.osProbes(), 1);
  assert.doesNotMatch(JSON.stringify(h.records), /private|secret/);
  h.monitor.stop();
});

test('健康探测先报错后，具体连接故障仍记录，仅 Windows 额外采集限频', async () => {
  const h = harness({ fetch: async () => { throw new Error('offline'); } });
  await h.monitor.sample();
  await flush();
  h.monitor.handleBackendMessage({ channel: RUNTIME_DIAGNOSTICS_CHANNEL, type: 'fault', code: 'CODEX_CONNECTION_TIMEOUT', metrics: { pid: 42 } });
  h.monitor.handleBackendMessage({ channel: RUNTIME_DIAGNOSTICS_CHANNEL, type: 'fault', code: 'CODEX_CONNECTION_ERROR', metrics: { pid: 42 } });
  await flush();
  assert.deepEqual(h.records.filter((r) => r.type === 'fault').map((r) => r.code),
    ['SERVICE_STALL', 'CODEX_CONNECTION_TIMEOUT', 'CODEX_CONNECTION_ERROR']);
  assert.equal(h.osProbes(), 1);
  h.monitor.stop();
});

test('Windows 采集尚未完成时到达的具体故障也不会丢失', async () => {
  let complete;
  let probes = 0;
  const h = harness({ collectPressure: () => { probes++; return new Promise((resolve) => { complete = resolve; }); } });
  const fault = (code) => h.monitor.handleBackendMessage({ channel: RUNTIME_DIAGNOSTICS_CHANNEL, type: 'fault', code });
  fault('CODEX_CONNECTION_TIMEOUT');
  fault('CODEX_CONNECTION_ERROR');
  assert.equal(h.records.filter((r) => r.type === 'fault').length, 2);
  assert.equal(probes, 1);
  complete({ status: 'ok' });
  await flush();
  h.advance(60_001);
  fault('CODEX_CONNECTION_ERROR');
  assert.equal(probes, 2);
  complete({ status: 'ok' });
  await flush();
  h.monitor.stop();
});

test('慢探测期间不重入，停止时取消请求且不再写日志', async () => {
  let attempts = 0;
  const h = harness({ fetch: async (_url, { signal }) => {
    attempts++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  const pending = h.monitor.sample();
  await h.monitor.sample();
  assert.equal(attempts, 3);
  h.monitor.stop();
  await pending;
  await h.monitor.sample();
  assert.equal(attempts, 3);
  assert.deepEqual(h.records, []);
});

test('采样失败、日志失败和 OS 采集失败均不向调用者抛出异常', async () => {
  const h = harness({ write: () => { throw new Error('disk full'); },
    fetch: async () => { throw new Error('offline'); }, collectPressure: async () => { throw new Error('denied'); } });
  await h.monitor.sample();
  await flush();
  h.monitor.stop();
});

test('探测超时会主动取消网络请求并形成故障记录', async () => {
  const h = harness({ timeoutMs: 10, fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }) });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await h.monitor.sample();
    await flush();
    assert.equal(h.records[0].services.every((s) => s.status === 'unreachable'), true);
    assert.equal(h.records[1].code, 'SERVICE_STALL');
  } finally { clearTimeout(keepAlive); h.monitor.stop(); }
});

test('Windows 压力探针有执行期限与输出上限，只接受端口白名单', async () => {
  const result = await collectWindowsPressure([9281, 'malicious'], { platform: 'win32', execFile: (file, args, options, cb) => {
    assert.equal(file, 'powershell.exe');
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 5000);
    assert.equal(options.maxBuffer, 8192);
    assert.doesNotMatch(args.join(' '), /malicious/);
    cb(null, JSON.stringify({ diskQueue: 2, token: 'secret', listeners: [{ LocalPort: 9281, OwningProcess: 42 }, { LocalPort: 123, OwningProcess: 1 }] }));
  } });
  assert.deepEqual(result.listeners, [{ port: 9281, pid: 42 }]);
  assert.equal(result.diskQueue, 2);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.deepEqual(await collectWindowsPressure([], { platform: 'win32', execFile: (_f, _a, _o, cb) => cb(new Error('timeout')) }), { status: 'unavailable' });
});

test('后端事件循环阻塞或启动器采样大幅迟到均触发故障记录', async () => {
  const h = harness();
  h.monitor.handleBackendMessage({ channel: RUNTIME_DIAGNOSTICS_CHANNEL, type: 'sample', metrics: { eventLoopMaxMs: 1500 } });
  h.advance(10_000);
  await h.monitor.sample();
  await flush();
  assert.equal(h.records.find((r) => r.type === 'fault').code, 'SERVICE_STALL');
  h.monitor.stop();
  const lag = harness();
  lag.advance(25_000);
  await lag.monitor.sample();
  await flush();
  assert.equal(lag.records[0].launcherLagMs, 15_000);
  assert.equal(lag.records[1].code, 'SERVICE_STALL');
  lag.monitor.stop();
});
