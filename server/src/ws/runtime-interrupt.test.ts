import assert from 'node:assert/strict';
import test from 'node:test';
import { requestRuntimeInterrupt } from './runtime-interrupt.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('非运行状态不触发中断', async () => {
  const calls: string[] = [];
  const runtime = { isRunning: false, isStopping: false, interruptPromise: null, engineConnection: { cancel: async () => { calls.push('interrupt'); } } };
  await requestRuntimeInterrupt(runtime, {
    onStarting: () => { calls.push('starting'); },
    onStopped: () => { calls.push('stopped'); },
    onFailed: () => { calls.push('failed'); },
  });
  assert.deepEqual(calls, []);
});

test('已认领但尚未建立引擎连接的回合可以取消一次', async () => {
  const calls: string[] = [];
  const runtime = { isRunning: true, isStopping: false, interruptPromise: null as Promise<void> | null, engineConnection: null };
  await requestRuntimeInterrupt(runtime, {
    canCancelBeforeConnection: true,
    onStarting: () => { calls.push('starting'); },
    onStopped: () => { calls.push('stopped'); runtime.isRunning = false; runtime.isStopping = false; },
    onFailed: () => { calls.push('failed'); },
  });
  assert.deepEqual(calls, ['starting', 'stopped']);
  assert.equal(runtime.interruptPromise, null);
});

test('未确认属于连接前阶段时不把失联回合误判为已取消', async () => {
  const calls: string[] = [];
  const runtime = { isRunning: true, isStopping: false, interruptPromise: null as Promise<void> | null, engineConnection: null };
  await assert.rejects(() => requestRuntimeInterrupt(runtime, {
    onStarting: () => { calls.push('starting'); },
    onStopped: () => { calls.push('stopped'); },
    onFailed: () => { calls.push('failed'); },
  }), /引擎连接尚未就绪/);
  assert.deepEqual(calls, ['starting', 'failed']);
});

test('并发调用复用同一中断 Promise 并只调用一次 Codex', async () => {
  const gate = deferred();
  const calls: string[] = [];
  const runtime = {
    isRunning: true,
    isStopping: false,
    interruptPromise: null as Promise<void> | null,
    engineConnection: { cancel: () => { calls.push('interrupt'); return gate.promise; } },
  };
  const hooks = {
    onStarting: () => { calls.push('starting'); },
    onStopped: () => { calls.push('stopped'); runtime.isRunning = false; runtime.isStopping = false; },
    onFailed: () => { calls.push('failed'); },
  };

  const first = requestRuntimeInterrupt(runtime, hooks);
  const second = requestRuntimeInterrupt(runtime, hooks);
  assert.equal(first, second);
  assert.deepEqual(calls, ['starting', 'interrupt']);
  assert.equal(runtime.isRunning, true);
  assert.equal(runtime.isStopping, true);

  gate.resolve();
  await first;
  assert.deepEqual(calls, ['starting', 'interrupt', 'stopped']);
  assert.equal(runtime.isRunning, false);
  assert.equal(runtime.isStopping, false);
  assert.equal(runtime.interruptPromise, null);
});

test('中断失败调用失败钩子并向等待方传播', async () => {
  const calls: string[] = [];
  const runtime = {
    isRunning: true,
    isStopping: false,
    interruptPromise: null as Promise<void> | null,
    engineConnection: { cancel: async () => { calls.push('interrupt'); throw new Error('interrupt failed'); } },
  };
  const promise = requestRuntimeInterrupt(runtime, {
    onStarting: () => { calls.push('starting'); },
    onStopped: () => { calls.push('stopped'); },
    onFailed: (error) => { calls.push(`failed:${error.message}`); },
  });

  await assert.rejects(() => promise, /interrupt failed/);
  assert.deepEqual(calls, ['starting', 'interrupt', 'failed:interrupt failed']);
  assert.equal(runtime.isRunning, true);
  assert.equal(runtime.isStopping, false);
  assert.equal(runtime.interruptPromise, null);
});

test('开始钩子失败时恢复 stopping 并传播给等待方', async () => {
  const calls: string[] = [];
  const runtime = {
    isRunning: true,
    isStopping: false,
    interruptPromise: null as Promise<void> | null,
    engineConnection: { cancel: async () => { calls.push('interrupt'); } },
  };

  await assert.rejects(() => requestRuntimeInterrupt(runtime, {
    onStarting: () => { calls.push('starting'); throw new Error('status failed'); },
    onStopped: () => { calls.push('stopped'); },
    onFailed: (error) => { calls.push(`failed:${error.message}`); },
  }), /status failed/);

  assert.deepEqual(calls, ['starting', 'failed:status failed']);
  assert.equal(runtime.isRunning, true);
  assert.equal(runtime.isStopping, false);
  assert.equal(runtime.interruptPromise, null);
});
