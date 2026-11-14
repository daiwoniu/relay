import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createLauncherHost, isLauncherHostShutdownRequest, parseLauncherHostRestartRequest, prepareLauncherReplacement, requestLauncherHostRestart, spawnLauncherRunner, waitForRelayPortsReleased } from './lib/launcher-host.mjs';

function fakeChild(pid) {
  const child = new EventEmitter();
  Object.assign(child, { pid, sent: [], send(message, callback) { this.sent.push(message); callback?.(null); } });
  return child;
}

test('稳定宿主以原终端 stdio 和 IPC 启动运行器', () => {
  let invocation;
  const child = fakeChild(1);
  spawnLauncherRunner({ root: 'G:\\relay', args: ['--dev'], spawnFn: (...args) => { invocation = args; return child; } });
  assert.match(invocation[1][0], /scripts[\\/]start\.mjs$/);
  assert.deepEqual(invocation[1].slice(1), ['--dev']);
  assert.deepEqual(invocation[2].stdio, ['inherit', 'inherit', 'inherit', 'ipc']);
  assert.equal(invocation[2].windowsHide, false);
  assert.equal(invocation[2].shell, false);
});

test('稳定宿主按配置目标检查端口释放', async () => {
  const connected = [];
  let round = 0;
  const targets = [{ host: '127.0.0.1', port: 9181 }, { host: '127.0.0.1', port: 9082 }];
  const released = await waitForRelayPortsReleased({
    targets,
    connect: (target) => {
      connected.push(target);
      const socket = new EventEmitter();
      socket.destroy = () => {};
      socket.setTimeout = () => {};
      queueMicrotask(() => socket.emit(round === 0 ? 'connect' : 'error'));
      return socket;
    },
    delay: async () => { round += 1; },
  });
  assert.equal(released, true);
  assert.deepEqual(connected[0], targets[0]);
  assert.deepEqual(connected[1], targets[1]);
});

test('宿主确认完整重启并在旧运行器干净退出、端口释放后原位换代', async () => {
  const children = [fakeChild(11), fakeChild(12)];
  const spawned = [];
  const exits = [];
  const host = createLauncherHost({
    root: 'G:\\relay', args: [],
    spawnRunner: (options) => { spawned.push(options); return children[spawned.length - 1]; },
    waitForPortsReleased: async () => true,
    exit: (code) => exits.push(code),
  });
  host.launch();
  const request = { channel: 'relay-launcher-host-v1', type: 'restart_request', requestId: '12345678-1234-1234-1234-123456789abc', preparedBuildId: 'abcdef123456' };
  children[0].emit('message', request);
  assert.equal(host.isRestartPending(), true);
  assert.deepEqual(children[0].sent, [{ channel: 'relay-launcher-host-v1', type: 'restart_response', requestId: request.requestId, accepted: true }]);
  children[0].emit('exit', 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawned.length, 2);
  assert.deepEqual(spawned[1].args, ['--prepared-build-id', 'abcdef123456']);
  assert.equal(host.getActiveChild(), children[1]);
  assert.deepEqual(exits, []);
});

test('宿主换代时不向新运行器重复传递一次性 restart 参数', async () => {
  const children = [fakeChild(11), fakeChild(12)];
  const spawned = [];
  const host = createLauncherHost({
    root: 'G:\\relay', args: ['--restart'],
    spawnRunner: (options) => { spawned.push(options); return children[spawned.length - 1]; },
    waitForPortsReleased: async () => true,
    exit: () => assert.fail('不应退出宿主'),
  });
  host.launch();
  assert.deepEqual(spawned[0].args, ['--restart']);
  const request = { channel: 'relay-launcher-host-v1', type: 'restart_request', requestId: '12345678-1234-1234-1234-123456789abc', preparedBuildId: 'abcdef123456' };
  children[0].emit('message', request);
  children[0].emit('exit', 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(spawned[1].args, ['--prepared-build-id', 'abcdef123456']);
});

test('宿主对普通退出和信号退出不自动重启', async () => {
  for (const [code, signal, expected] of [[0, null, 0], [null, 'SIGTERM', 1]]) {
    const child = fakeChild(21);
    const exits = [];
    let spawns = 0;
    createLauncherHost({ root: 'G:\\relay', spawnRunner: () => { spawns += 1; return child; }, waitForPortsReleased: async () => true, exit: (value) => exits.push(value) }).launch();
    child.emit('exit', code, signal);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(spawns, 1);
    assert.deepEqual(exits, [expected]);
  }
});

test('宿主完整重启预约超时后不会把未来普通退出误判为换代', async () => {
  const child = fakeChild(31);
  let spawns = 0;
  const exits = [];
  const host = createLauncherHost({
    root: 'G:\\relay', restartReservationMs: 1, waitForPortsReleased: async () => true,
    spawnRunner: () => { spawns += 1; return child; },
    exit: (code) => exits.push(code),
  });
  host.launch();
  child.emit('message', { channel: 'relay-launcher-host-v1', type: 'restart_request', requestId: '12345678-1234-1234-1234-123456789abc', preparedBuildId: 'abcdef123456' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(host.isRestartPending(), false);
  child.emit('exit', 0, null);
  assert.equal(spawns, 1);
  assert.deepEqual(exits, [0]);
});

test('宿主确认发送失败时不预约换代，允许运行器回退 helper', () => {
  const child = fakeChild(41);
  child.send = (message, callback) => { child.sent.push(message); callback?.(new Error('ipc closed')); };
  const host = createLauncherHost({ root: 'G:\\relay', spawnRunner: () => child, exit: () => {} });
  host.launch();
  child.emit('message', { channel: 'relay-launcher-host-v1', type: 'restart_request', requestId: '12345678-1234-1234-1234-123456789abc', preparedBuildId: 'abcdef123456' });
  assert.equal(host.isRestartPending(), false);
});

test('运行器退出早于宿主发送回调时仍按已确认请求换代', async () => {
  const first = fakeChild(45);
  const second = fakeChild(46);
  let confirmCallback;
  first.send = (message, callback) => { first.sent.push(message); confirmCallback = callback; };
  let spawns = 0;
  const host = createLauncherHost({
    root: 'G:\\relay',
    spawnRunner: () => { spawns += 1; return spawns === 1 ? first : second; },
    waitForPortsReleased: async () => true,
    exit: () => assert.fail('不应退出宿主'),
  });
  host.launch();
  first.emit('message', { channel: 'relay-launcher-host-v1', type: 'restart_request', requestId: '12345678-1234-1234-1234-123456789abc', preparedBuildId: 'abcdef123456' });
  first.emit('exit', 0, null);
  assert.equal(spawns, 1);
  confirmCallback(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawns, 2);
});

test('宿主不在运行器非零退出或端口未释放时启动新版', async () => {
  for (const [exitCode, portsReleased] of [[1, true], [0, false]]) {
    const first = fakeChild(51);
    let spawns = 0;
    const exits = [];
    const host = createLauncherHost({
      root: 'G:\\relay',
      spawnRunner: () => { spawns += 1; return first; },
      waitForPortsReleased: async () => portsReleased,
      exit: (code) => exits.push(code),
    });
    host.launch();
    first.emit('message', { channel: 'relay-launcher-host-v1', type: 'restart_request', requestId: '12345678-1234-1234-1234-123456789abc', preparedBuildId: 'abcdef123456' });
    first.emit('exit', exitCode, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(spawns, 1);
    assert.deepEqual(exits, [1]);
  }
});

test('宿主收到终止信号后取消换代并请求活动运行器优雅清理', async () => {
  const child = fakeChild(61);
  const exits = [];
  const host = createLauncherHost({ root: 'G:\\relay', spawnRunner: () => child, waitForPortsReleased: async () => true, exit: (code) => exits.push(code), platform: 'win32' });
  host.launch();
  child.emit('message', { channel: 'relay-launcher-host-v1', type: 'restart_request', requestId: '12345678-1234-1234-1234-123456789abc', preparedBuildId: 'abcdef123456' });
  host.stop('SIGINT');
  assert.deepEqual(child.sent.at(-1), { channel: 'relay-launcher-host-v1', type: 'shutdown_request' });
  assert.equal(host.isRestartPending(), false);
  child.emit('exit', 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [130]);
});

test('宿主 shutdown IPC 只接受固定无参数消息', () => {
  assert.equal(isLauncherHostShutdownRequest({ channel: 'relay-launcher-host-v1', type: 'shutdown_request' }), true);
  assert.equal(isLauncherHostShutdownRequest({ channel: 'relay-launcher-host-v1', type: 'shutdown_request', command: 'calc' }), false);
});

test('运行器未响应宿主停止请求时有限超时并强制清理进程树', async () => {
  const child = fakeChild(65);
  let forced = null;
  const exits = [];
  const host = createLauncherHost({
    root: 'G:\\relay', spawnRunner: () => child, shutdownTimeoutMs: 1,
    forceStopChild: async (target) => { forced = target; },
    exit: (code) => exits.push(code), writeError: () => {},
  });
  host.launch();
  host.stop('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(forced, child);
  assert.deepEqual(exits, [143]);
});

test('宿主协议严格且运行器等待匹配确认', async () => {
  const valid = { channel: 'relay-launcher-host-v1', type: 'restart_request', requestId: '12345678-1234-1234-1234-123456789abc', preparedBuildId: 'abcdef123456' };
  assert.deepEqual(parseLauncherHostRestartRequest(valid), valid);
  assert.equal(parseLauncherHostRestartRequest({ ...valid, command: 'calc' }), null);
  assert.equal(parseLauncherHostRestartRequest({ ...valid, preparedBuildId: '..\\start.mjs' }), null);

  const runtime = new EventEmitter();
  runtime.connected = true;
  runtime.send = (message, callback) => {
    runtime.sentMessage = message;
    callback?.(null);
    runtime.emit('message', { channel: 'relay-launcher-host-v1', type: 'restart_response', requestId: message.requestId, accepted: true });
  };
  assert.equal(await requestLauncherHostRestart(runtime, 2_000, 'abcdef123456'), 'accepted');
  assert.equal(runtime.sentMessage?.preparedBuildId, 'abcdef123456');
  assert.equal(await requestLauncherHostRestart({ connected: false }), 'unavailable');
});

test('宿主按运行模式拒绝缺失或多余的预构建身份', () => {
  const productionChild = fakeChild(81);
  createLauncherHost({ root: 'G:\\relay', spawnRunner: () => productionChild, exit: () => {} }).launch();
  productionChild.emit('message', { channel: 'relay-launcher-host-v1', type: 'restart_request', requestId: '12345678-1234-1234-1234-123456789abc', preparedBuildId: null });
  assert.equal(productionChild.sent.at(-1).accepted, false);

  const developmentChild = fakeChild(82);
  createLauncherHost({ root: 'G:\\relay', args: ['--dev'], spawnRunner: () => developmentChild, exit: () => {} }).launch();
  developmentChild.emit('message', { channel: 'relay-launcher-host-v1', type: 'restart_request', requestId: '12345678-1234-1234-1234-123456789abd', preparedBuildId: 'abcdef123456' });
  assert.equal(developmentChild.sent.at(-1).accepted, false);
});

test('宿主响应超时属于不确定状态，绝不启动 helper 形成双启动', async () => {
  const runtime = new EventEmitter();
  runtime.connected = true;
  runtime.send = (_message, callback) => callback?.(null);
  assert.equal(await requestLauncherHostRestart(runtime, 1), 'ambiguous');

  let fallbackCalls = 0;
  await assert.rejects(() => prepareLauncherReplacement({
    requestHostRestart: async () => 'ambiguous',
    spawnFallback: () => { fallbackCalls += 1; },
  }), /无法确认稳定终端宿主/);
  assert.equal(fallbackCalls, 0);
});

test('仅确认宿主不可用时启动 helper 兜底', async () => {
  const fallback = { pid: 71 };
  assert.deepEqual(await prepareLauncherReplacement({
    requestHostRestart: async () => 'accepted',
    spawnFallback: () => assert.fail('不应启动 helper'),
    hostedPid: 70,
  }), { pid: 70, hosted: true });
  assert.equal(await prepareLauncherReplacement({ requestHostRestart: async () => 'unavailable', spawnFallback: () => fallback }), fallback);
});
