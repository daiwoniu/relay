import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createSetupProcessController } from './lib/setup-process.mjs';

function child(pid = 101) {
  const value = new EventEmitter();
  value.pid = pid;
  return value;
}

test('setup 控制器跟踪活动子进程并在退出后清理', async () => {
  const setupChild = child();
  const controller = createSetupProcessController({
    spawnSetup: () => setupChild,
    stopProcess: async () => {},
  });
  const running = controller.run();
  assert.equal(controller.getActiveChild(), setupChild);
  setupChild.emit('exit', 0, null);
  await running;
  assert.equal(controller.getActiveChild(), null);
});

test('启动器停止时会终止仍在运行的 setup 子进程', async () => {
  const setupChild = child();
  const stopped = [];
  const controller = createSetupProcessController({
    spawnSetup: () => setupChild,
    stopProcess: async (target) => {
      stopped.push(target.pid);
      target.emit('exit', null, 'SIGTERM');
    },
  });
  const running = controller.run();
  assert.equal(await controller.stop(), true);
  await assert.rejects(running, /SIGTERM/);
  assert.deepEqual(stopped, [101]);
  assert.equal(controller.getActiveChild(), null);
});

test('同一时间拒绝启动第二个 setup 子进程', async () => {
  const setupChild = child();
  const controller = createSetupProcessController({ spawnSetup: () => setupChild, stopProcess: async () => {} });
  const running = controller.run();
  await assert.rejects(() => controller.run(), /已有初始化进程/);
  setupChild.emit('exit', 0, null);
  await running;
});

test('setup 控制器在等待退出前同步交付新子进程', async () => {
  const child = new EventEmitter();
  const spawned = [];
  const controller = createSetupProcessController({
    spawnSetup: () => child,
    onSpawn: (value) => spawned.push(value),
    stopProcess: async () => {},
  });
  const running = controller.run();
  assert.deepEqual(spawned, [child]);
  child.emit('exit', 0, null);
  await running;
});

test('setup 子进程成功但收尾失败时事务必须失败', async () => {
  const setupChild = child();
  const controller = createSetupProcessController({
    label: 'CodeBuddy readiness',
    spawnSetup: () => setupChild,
    cleanupProcess: async () => { throw new Error('临时目录仍被占用'); },
    stopProcess: async () => {},
  });
  const running = controller.run();
  setupChild.emit('exit', 0, null);
  await assert.rejects(running, /临时目录仍被占用/);
  assert.equal(controller.getActiveChild(), null);
});

test('setup 子进程与收尾都失败时保留原始进程错误', async () => {
  const setupChild = child();
  const cleanupErrors = [];
  const controller = createSetupProcessController({
    label: 'CodeBuddy readiness',
    spawnSetup: () => setupChild,
    cleanupProcess: async () => { throw new Error('清理失败'); },
    onCleanupError: (error) => cleanupErrors.push(error.message),
    stopProcess: async () => {},
  });
  const running = controller.run();
  setupChild.emit('exit', 1, null);
  await assert.rejects(running, /CodeBuddy readiness退出码 1/);
  assert.deepEqual(cleanupErrors, ['清理失败']);
  assert.equal(controller.getActiveChild(), null);
});

test('setup 子进程失败保留退出码供维护事务分类', async () => {
  const setupChild = child();
  const controller = createSetupProcessController({ label: 'CodeBuddy readiness', spawnSetup: () => setupChild });
  const running = controller.run();
  setupChild.emit('exit', 42, null);
  await assert.rejects(running, (error) => error.exitCode === 42 && /退出码 42/.test(error.message));
});

test('setup 控制器等待异步收尾完成后才结束事务', async () => {
  const setupChild = child();
  let finishCleanup;
  let settled = false;
  const controller = createSetupProcessController({
    spawnSetup: () => setupChild,
    cleanupProcess: () => new Promise((resolve) => { finishCleanup = resolve; }),
    stopProcess: async () => {},
  });
  const running = controller.run().finally(() => { settled = true; });
  setupChild.emit('exit', 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(controller.getActiveChild(), setupChild);
  finishCleanup();
  await running;
  assert.equal(controller.getActiveChild(), null);
});

test('setup 控制器按通道转发子进程输出并携带本次 operation context', async () => {
  const setupChild = child();
  setupChild.stdout = new PassThrough();
  setupChild.stderr = new PassThrough();
  const output = [];
  const context = { operationId: 'op-1' };
  const controller = createSetupProcessController({
    spawnSetup: (received) => { assert.equal(received, context); return setupChild; },
    onOutput: (channel, chunk, received) => output.push([channel, String(chunk), received.operationId]),
    stopProcess: async () => {},
  });
  const running = controller.run(context);
  setupChild.stdout.write('标准输出\n');
  setupChild.stderr.write('标准错误\n');
  setupChild.emit('exit', 0, null);
  await running;
  assert.deepEqual(output, [
    ['stdout', '标准输出\n', 'op-1'],
    ['stderr', '标准错误\n', 'op-1'],
  ]);
});
