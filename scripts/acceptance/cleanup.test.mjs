import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupEdgeRuntime } from './lib/edge-runtime.mjs';
import { ACCEPTANCE_ROOT, assertSafeCleanupTarget, finalizeRunState, selectOwnedProcesses, validateRunState, writeRunState } from './lib/run-state.mjs';

test('清理拒绝根目录、缺少 run ID 和宽泛目标', () => {
  for (const value of ['', '.', '.relay-dev/acceptance', 'G:\\AI\\relay', 'run', 'nested/run-0123456789abcdef']) {
    assert.throws(() => assertSafeCleanupTarget(value), /清理|run ID/);
  }
});

test('只选择命令行包含本次完整 profile 路径的 PID', () => {
  const profile = path.join(ACCEPTANCE_ROOT, 'run-0123456789abcdef', 'profile');
  const selected = selectOwnedProcesses([
    { pid: 10, name: 'msedge.exe', commandLine: `msedge.exe --user-data-dir=${profile}` },
    { pid: 11, name: 'msedge.exe', commandLine: 'msedge.exe --user-data-dir=C:\\Users\\normal\\Edge' },
    { pid: 12, name: 'powershell.exe', commandLine: `powershell.exe process-control.ps1 terminate ${profile}` },
  ], profile);
  assert.deepEqual(selected, [10]);
  assert.throws(() => selectOwnedProcesses([], 'G:\\AI\\relay'), /profile/);
});

test('运行状态拒绝远程或端口不一致的 CDP 地址和未知字段', () => {
  const runDir = 'G:\\AI\\relay\\.relay-dev\\acceptance\\run-0123456789abcdef';
  const base = {
    runId: 'run-0123456789abcdef',
    pid: 10,
    profileDir: `${runDir}\\profile`,
    port: 43210,
    webSocketUrl: 'ws://127.0.0.1:43210/devtools/browser/id',
    status: 'running',
    startedAt: '2026-08-14T00:00:00.000Z',
  };
  assert.deepEqual(validateRunState(base, runDir), base);
  assert.throws(() => validateRunState({ ...base, webSocketUrl: 'ws://example.com/devtools/browser/id' }, runDir), /WebSocket/);
  assert.throws(() => validateRunState({ ...base, webSocketUrl: 'ws://127.0.0.1:43211/devtools/browser/id' }, runDir), /WebSocket/);
  assert.throws(() => validateRunState({ ...base, cookie: 'secret' }, runDir), /未知字段/);
});

test('运行状态只写入明确 run 目录且不保存完整命令行', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-run-state-'));
  try {
    const statePath = path.join(root, 'state.json');
    writeRunState(statePath, { runId: 'run-0123456789abcdef', pid: 10, profileDir: 'profile', port: 12345, commandLine: 'secret' }, { assertStatePath: () => {} });
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.pid, 10);
    assert.equal('commandLine' in state, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('验收结束后按资源清理结果收口运行状态', () => {
  const writes = [];
  const runtime = {
    runId: 'run-0123456789abcdef',
    statePath: 'state.json',
    pid: 10,
    profileDir: 'profile',
    port: 12345,
    webSocketUrl: 'ws://127.0.0.1:12345/devtools/browser/id',
    startedAt: '2026-08-15T00:00:00.000Z',
  };
  const writeState = (statePath, state) => { writes.push({ statePath, state }); return state; };

  finalizeRunState(runtime, { process: 'cleaned', port: 'released', profile: 'removed' }, {
    writeState,
    now: () => new Date('2026-08-15T00:01:00.000Z'),
  });
  finalizeRunState(runtime, { process: 'remaining', port: 'released', profile: 'remaining' }, {
    writeState,
    now: () => new Date('2026-08-15T00:02:00.000Z'),
  });

  assert.equal(writes[0].state.status, 'cleaned');
  assert.equal(writes[0].state.updatedAt, '2026-08-15T00:01:00.000Z');
  assert.equal(writes[1].state.status, 'cleanup_incomplete');
});

test('清理顺序固定并输出进程、端口、profile 三项结论', async () => {
  const order = [];
  const result = await cleanupEdgeRuntime({
    runtime: { pid: 10, port: 12345, profileDir: 'safe-profile' },
    cdp: { closeBrowser: async () => { order.push('browser-close'); } },
    waitForExit: async () => { order.push('wait-exit'); return false; },
    terminateOwned: async () => { order.push('terminate-owned'); return [10]; },
    queryOwned: async () => { order.push('query-owned'); return []; },
    checkPortReleased: async () => { order.push('port-check'); return true; },
    removeProfile: async () => { order.push('remove-profile'); return true; },
  });
  assert.deepEqual(order, ['browser-close', 'wait-exit', 'terminate-owned', 'query-owned', 'port-check', 'remove-profile']);
  assert.deepEqual(result, { process: 'cleaned', port: 'released', profile: 'removed' });
});
