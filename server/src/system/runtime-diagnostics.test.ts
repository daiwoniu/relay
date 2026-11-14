import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeDiagnostics, RUNTIME_DIAGNOSTICS_CHANNEL } from './runtime-diagnostics.js';

test('后端采样上报事件循环延迟，停止后不再上报', async () => {
  const records: Record<string, any>[] = [];
  let enabled = 0;
  let disabled = 0;
  const monitor = createRuntimeDiagnostics({ emit: (r) => records.push(r), intervalMs: 5,
    histogram: { enable: () => { enabled++; return true; }, disable: () => { disabled++; return true; },
      reset() {}, percentile: () => 80e6, max: 1200e6 } });
  monitor.start();
  monitor.start();
  await new Promise((resolve) => setTimeout(resolve, 22));
  monitor.stop();
  assert.equal(enabled, 1);
  assert.equal(disabled, 1);
  assert.ok(records.length > 0);
  assert.equal(records[0].channel, RUNTIME_DIAGNOSTICS_CHANNEL);
  assert.equal(records[0].metrics.eventLoopP99Ms, 80);
  assert.equal(records[0].metrics.eventLoopMaxMs, 1200);
  assert.ok(records[0].metrics.rssMb > 0);
  const count = records.length;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(records.length, count);
});

test('连接故障只发送固定代码，不吞掉后续故障，IPC 失败不能中断请求', () => {
  const records: Record<string, unknown>[] = [];
  const monitor = createRuntimeDiagnostics({ emit: (r) => records.push(r) });
  monitor.fault('token=secret');
  monitor.fault('CODEX_CONNECTION_TIMEOUT');
  monitor.fault('CODEX_CONNECTION_TIMEOUT');
  monitor.fault('CODEX_CONNECTION_ERROR');
  assert.equal(records.length, 3);
  assert.equal(records[0].code, 'CODEX_CONNECTION_TIMEOUT');
  assert.equal(records[2].code, 'CODEX_CONNECTION_ERROR');
  assert.doesNotMatch(JSON.stringify(records), /secret/);
  monitor.stop();
  const broken = createRuntimeDiagnostics({ emit: () => { throw new Error('IPC closed'); } });
  assert.doesNotThrow(() => broken.fault('CODEX_CONNECTION_TIMEOUT'));
  broken.stop();
});
