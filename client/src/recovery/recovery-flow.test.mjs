import assert from 'node:assert/strict';
import test from 'node:test';
import { getRecoveryCompletionEffect, pollForRecovery } from './recovery-flow.ts';

test('轮询允许短暂网络失败并在后端健康且协议一致时成功', async () => {
  let calls = 0;
  let now = 0;
  const result = await pollForRecovery({
    target: 'backend',
    clientProtocolVersion: 11,
    probe: async () => {
      calls += 1;
      if (calls < 3) throw new Error('temporarily offline');
      return { healthy: true, serverProtocolVersion: 11 };
    },
    wait: async (milliseconds) => { now += milliseconds; },
    now: () => now,
  });
  assert.equal(result.status, 'ready');
  assert.equal(calls, 3);
});

test('后端启动超过 30 秒仍继续等待并确认新实例', async () => {
  let clock = 0;
  const result = await pollForRecovery({
    target: 'backend',
    clientProtocolVersion: 35,
    intervalMs: 1_000,
    requireExplicitRestartObserved: true,
    now: () => clock,
    wait: async (milliseconds) => { clock += milliseconds; },
    probe: async () => {
      if (clock < 49_500) throw new Error('backend restarting');
      return { healthy: true, serverProtocolVersion: 35, restartObserved: true };
    },
  });
  assert.equal(result.status, 'ready');
  assert.equal(clock, 50_000);
});

test('后端轮询覆盖启动器的 10 分钟预算并在期限结束后停止', async () => {
  let now = 0;
  let calls = 0;
  const result = await pollForRecovery({
    target: 'backend',
    clientProtocolVersion: 11,
    intervalMs: 1_000,
    probe: async () => { calls += 1; return { healthy: false, serverProtocolVersion: null }; },
    wait: async (milliseconds) => { now += milliseconds; },
    now: () => now,
  });
  assert.equal(result.status, 'timeout');
  assert.equal(now, 630_000);
  assert.equal(calls, 630);
});

test('前端未观察到中断或实例切换时不能误判恢复', async () => {
  let now = 0;
  let calls = 0;
  const result = await pollForRecovery({
    target: 'frontend',
    clientProtocolVersion: 11,
    probe: async () => { calls += 1; return { healthy: true, serverProtocolVersion: 11 }; },
    wait: async (milliseconds) => { now += milliseconds; },
    now: () => now,
  });
  assert.equal(result.status, 'timeout');
  assert.ok(calls <= 61);
});

test('前端实例切换后判定恢复', async () => {
  const result = await pollForRecovery({
    target: 'frontend',
    clientProtocolVersion: 11,
    probe: async () => ({ healthy: true, serverProtocolVersion: 11, restartObserved: true }),
  });
  assert.equal(result.status, 'ready');
});

test('setup 在第一次轮询前已经失败时立即返回失败', async () => {
  let calls = 0;
  const result = await pollForRecovery({
    target: 'setup',
    clientProtocolVersion: 11,
    requireExplicitRestartObserved: true,
    probe: async () => {
      calls += 1;
      return { healthy: true, serverProtocolVersion: 11, operationInProgress: false, terminalFailure: true };
    },
  });
  assert.equal(result.status, 'failed');
  assert.equal(calls, 1);
});

test('后端恢复显式重连，前端恢复或浏览器旧版本时刷新页面', () => {
  assert.equal(getRecoveryCompletionEffect('backend'), 'reconnect_websocket');
  assert.equal(getRecoveryCompletionEffect('frontend'), 'reload_page');
  assert.equal(getRecoveryCompletionEffect('relay'), 'reload_page');
  assert.equal(getRecoveryCompletionEffect('reload_browser'), 'reload_page');
});

test('确认未知时维护状态短暂消失不能提前失败，等待后续实例切换', async () => {
  let calls = 0; let clock = 0;
  const result = await pollForRecovery({ target: 'relay', clientProtocolVersion: 34, requireExplicitRestartObserved: true,
    timeoutMs: 100, intervalMs: 5, now: () => clock, wait: async (ms) => { clock += ms; },
    probe: async () => {
      calls++;
      return { healthy: calls > 1, operationInProgress: calls === 1,
        serverProtocolVersion: 34, restartObserved: calls >= 3 };
    } });
  assert.equal(result.status, 'ready');
  assert.equal(calls, 3);
});

test('维护状态消失但实例一直未切换时等待至期限，不判成功也不提前失败', async () => {
  let calls = 0; let clock = 0;
  const result = await pollForRecovery({ target: 'frontend', clientProtocolVersion: 34, requireExplicitRestartObserved: true,
    timeoutMs: 20, intervalMs: 5, now: () => clock, wait: async (ms) => { clock += ms; },
    probe: async () => ({ healthy: ++calls > 1, operationInProgress: calls === 1,
      serverProtocolVersion: 34, restartObserved: false }) });
  assert.equal(result.status, 'timeout');
  assert.equal(clock, 20);
  assert.equal(calls, 4);
});
