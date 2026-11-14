import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexLifecycleMonitor, ensureCodexProcessReady, releaseCodexProcessReady } from './codex-lifecycle.js';

test('Codex 生命周期监视器只在活动状态变化时发送信号', async () => {
  let active = false;
  const messages: string[] = [];
  const monitor = createCodexLifecycleMonitor({
    readActive: () => active,
    send: (message) => messages.push(message.type),
    intervalMs: 5,
  });

  monitor.start();
  await new Promise((resolve) => setTimeout(resolve, 12));
  active = true;
  await new Promise((resolve) => setTimeout(resolve, 12));
  active = false;
  await new Promise((resolve) => setTimeout(resolve, 12));
  monitor.stop();

  assert.deepEqual(messages, ['idle', 'activity_started', 'idle']);
});

test('Codex 生命周期监视器停止后不再发送状态变化', async () => {
  let active = false;
  const messages: string[] = [];
  const monitor = createCodexLifecycleMonitor({
    readActive: () => active,
    send: (message) => messages.push(message.type),
    intervalMs: 5,
  });

  monitor.start();
  monitor.stop();
  active = true;
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.deepEqual(messages, ['idle']);
});

test('唤醒已空闲停止的 Codex 并等待 readyz 恢复', async () => {
  const messages: string[] = [];
  let attempts = 0;
  const woke = await ensureCodexProcessReady({
    send: (message) => messages.push(message.type),
    isReady: async () => ++attempts >= 3,
    intervalMs: 0,
    timeoutMs: 100,
  });
  assert.deepEqual(messages, ['activity_started']);
  assert.equal(attempts, 3);
  assert.equal(woke, true);
});

test('Codex 生命周期就绪时不占用新的活动租约', async () => {
  const woke = await ensureCodexProcessReady({ isReady: async () => true, send: () => { throw new Error('should not send'); } });
  assert.equal(woke, false);
});

test('后台操作释放 Codex 时不覆盖正在执行的会话状态', () => {
  const messages: string[] = [];
  const send = (message: { type: string }) => { messages.push(message.type); };
  assert.equal(releaseCodexProcessReady({ readActive: () => true, send }), false);
  assert.deepEqual(messages, []);
  assert.equal(releaseCodexProcessReady({ readActive: () => false, send }), true);
  assert.deepEqual(messages, ['idle']);
  assert.equal(releaseCodexProcessReady({ readActive: () => { throw new Error('数据库不可用'); }, send }), false);
  assert.deepEqual(messages, ['idle']);
});
