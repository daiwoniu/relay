import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { formatProcessMemory, getProcessMemoryPresentation, getSystemResourcePresentation } from './system-resource-status.ts';

const snapshot = (level, usagePercent) => ({
  available: true,
  level,
  committedBytes: usagePercent,
  commitLimitBytes: 100,
  usagePercent,
  observedAt: 123,
  warningThresholdPercent: 80,
  criticalThresholdPercent: 90,
});

test('进程展示明确Relay范围、后端本体和同名进程合计，兼容旧响应', () => {
  assert.equal(getProcessMemoryPresentation(null).available, false);
  assert.equal(getProcessMemoryPresentation(snapshot('normal', 50)).relaySummary, '暂不可用');
  const data = { ...snapshot('warning', 82), processMemory: {
    relay: { privateBytes: 2 * 1024 ** 3, backendPrivateBytes: 200 * 1024 ** 2, processCount: 10, scope: 'managed' },
    topProcesses: [{ name: 'msedge.exe', privateBytes: 1.5 * 1024 ** 3, processCount: 20 }],
  } };
  const managed = getProcessMemoryPresentation(data);
  assert.equal(managed.relaySummary, '2.0 GiB · 10 个进程');
  assert.match(managed.relayDetail, /含受管启动器、前后端、引擎及工具子进程；后端本身 200 MiB/);
  assert.equal(managed.rows[0].memoryLabel, '1.5 GiB');
  assert.equal(managed.rows[0].processCount, 20);
  data.processMemory.relay.scope = 'backend';
  assert.match(getProcessMemoryPresentation(data).relayDetail, /未纳入独立运行/);
  assert.equal(formatProcessMemory(512 * 1024 ** 2), '512 MiB');
});

test('资源状态稳定区分正常、提示、严重和不可用', () => {
  assert.equal(getSystemResourcePresentation(snapshot('normal', 79)).tone, 'neutral');
  assert.equal(getSystemResourcePresentation(snapshot('warning', 80)).tone, 'warning');
  const critical = getSystemResourcePresentation(snapshot('critical', 90));
  assert.equal(critical.tone, 'critical');
  assert.match(critical.detail, /不会自动终止进程或中断任务/);
  assert.match(getSystemResourcePresentation(null).detail, /不影响 Relay 任务运行/);
});

test('Relay 维护面板接入只读资源状态且接口不携带控制动作', () => {
  const dialog = fs.readFileSync(new URL('./ServiceMaintenanceDialog.tsx', import.meta.url), 'utf8');
  const api = fs.readFileSync(new URL('../../api/system.ts', import.meta.url), 'utf8');
  assert.match(dialog, /<SystemResourceStatus active=\{open\}/);
  assert.match(api, /requestJson\('\/api\/system\/resources'/);
  assert.doesNotMatch(api, /kill|terminate|admission/i);
});

