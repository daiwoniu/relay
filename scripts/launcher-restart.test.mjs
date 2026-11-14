import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPreparedBuildIdArgument, launcherRestartArguments, launcherRunnerArguments, parseLauncherRestartArguments, spawnLauncherRestartHelper, waitForLauncherExitAndPorts } from './lib/launcher-restart.mjs';

test('完整重启 helper 参数固定且拒绝命令路径注入', () => {
  const args = launcherRestartArguments({ parentPid: 123, mode: 'production', lan: true, preparedBuildId: 'abcdef123456' });
  assert.deepEqual(parseLauncherRestartArguments(args), { parentPid: 123, mode: 'production', lan: true, preparedBuildId: 'abcdef123456' });
  assert.equal(parseLauncherRestartArguments([...args, '--verbose']), null);
  assert.equal(parseLauncherRestartArguments([...args, '--command', 'calc']), null);
  assert.equal(parseLauncherRestartArguments([...args, 'calc']), null);
  assert.equal(parseLauncherRestartArguments(args.with(args.length - 1, '..\\start.mjs')), null);
  assert.throws(() => launcherRestartArguments({ parentPid: 123, mode: 'development', preparedBuildId: 'abcdef123456' }), /预构建身份/);
  assert.deepEqual(launcherRunnerArguments({ root: 'G:\\relay', mode: 'production', preparedBuildId: 'abcdef123456' }).slice(1), ['--prepared-build-id', 'abcdef123456']);
  assert.deepEqual(extractPreparedBuildIdArgument(['--dev', '--prepared-build-id', 'abcdef123456']), { args: ['--dev'], preparedBuildId: 'abcdef123456' });
  assert.throws(() => extractPreparedBuildIdArgument(['--prepared-build-id', '..\\start.mjs']), /Build ID 无效/);
});

test('helper 使用 detached、IPC 握手和固定项目脚本', async () => {
  let invocation;
  const listeners = {};
  const child = {
    unrefCalled: false, disconnected: false,
    on(event, listener) { listeners[event] = listener; }, once(event, listener) { listeners[event] = listener; }, off() {},
    send(message, callback) { this.sent = message; callback?.(null); }, disconnect() { this.disconnected = true; }, unref() { this.unrefCalled = true; },
  };
  const promise = spawnLauncherRestartHelper({ root: 'G:\\relay', parentPid: 321, preparedBuildId: 'abcdef123456', spawnFn: (...args) => { invocation = args; return child; } });
  listeners.message({ channel: 'relay-launcher-restart-v1', type: 'ready' });
  await promise;
  assert.equal(invocation[2].detached, true);
  assert.equal(invocation[2].windowsHide, true);
  assert.deepEqual(invocation[2].stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.match(invocation[1][0], /launcher-restart-helper\.mjs$/);
  assert.deepEqual(invocation[1].slice(-2), ['--prepared-build-id', 'abcdef123456']);
  assert.equal(child.unrefCalled, true);
  assert.equal(child.disconnected, true);
});

test('helper 就绪超时或提前退出时拒绝完整重启', async () => {
  const timeoutListeners = {};
  const timeoutChild = {
    killed: false, disconnected: false,
    on(event, listener) { timeoutListeners[event] = listener; },
    once(event, listener) { timeoutListeners[event] = listener; },
    off() {},
    send(message) { this.sent = message; },
    disconnect() { this.disconnected = true; },
    kill() { this.killed = true; },
  };
  await assert.rejects(
    spawnLauncherRestartHelper({ root: 'G:\\relay', mode: 'development', spawnFn: () => timeoutChild, timeoutMs: 1 }),
    /就绪超时/,
  );
  assert.deepEqual(timeoutChild.sent, { channel: 'relay-launcher-restart-v1', type: 'cancel' });
  assert.equal(timeoutChild.disconnected, true);
  assert.equal(timeoutChild.killed, true);

  const exitListeners = {};
  const exitChild = {
    on(event, listener) { exitListeners[event] = listener; },
    once(event, listener) { exitListeners[event] = listener; },
    off() {},
  };
  const exited = spawnLauncherRestartHelper({ root: 'G:\\relay', mode: 'development', spawnFn: () => exitChild });
  exitListeners.exit();
  await assert.rejects(exited, /就绪前退出/);

  const beginListeners = {};
  const beginChild = {
    killed: false,
    on(event, listener) { beginListeners[event] = listener; },
    once(event, listener) { beginListeners[event] = listener; },
    off() {},
    send(message) { this.sent = message; },
    disconnect() {},
    kill() { this.killed = true; },
  };
  const beginTimeout = spawnLauncherRestartHelper({ root: 'G:\\relay', mode: 'development', spawnFn: () => beginChild, timeoutMs: 1 });
  beginListeners.message({ channel: 'relay-launcher-restart-v1', type: 'ready' });
  await assert.rejects(beginTimeout, /开始指令投递超时/);
  assert.equal(beginChild.killed, true);
});

test('只有父启动器退出且全部端口释放才继续', async () => {
  let round = 0;
  const targets = [{ host: '127.0.0.1', port: 9181 }, { host: '127.0.0.1', port: 9082 }];
  const result = await waitForLauncherExitAndPorts({
    parentPid: 1,
    targets,
    processAlive: async () => round < 2,
    targetListening: async () => round < 3,
    delay: async () => { round += 1; },
    timeoutMs: 5_000,
  });
  assert.equal(result, true);
  assert.equal(round, 3);
});

test('父启动器或端口持续占用时 helper 有限超时', async () => {
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const result = await waitForLauncherExitAndPorts({
      parentPid: 1,
      targets: [{ host: '127.0.0.1', port: 9181 }],
      processAlive: async () => true,
      targetListening: async () => true,
      delay: async (milliseconds) => { now += milliseconds; },
      timeoutMs: 500,
      intervalMs: 250,
    });
    assert.equal(result, false);
  } finally {
    Date.now = originalNow;
  }
});
