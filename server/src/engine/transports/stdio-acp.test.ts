import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { JsonRpcConnectionClosedError, JsonRpcCore } from '../json-rpc/core.js';
import {
  AcpProcessExitError,
  buildKnownProcessGroupTermination,
  buildKnownProcessTreeTermination,
  StdioAcpTransport,
  StdioAcpTransportParseError,
  type AcpChildProcess,
} from './stdio-acp.js';

class FakeChild extends EventEmitter implements AcpChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4321;
  exitCode: number | null = null;
  readonly input: string[] = [];

  constructor() {
    super();
    this.stdin.on('data', (chunk) => this.input.push(chunk.toString()));
  }

  kill(): boolean {
    return true;
  }

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待 ACP transport 条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('ACP stdio transport 使用固定参数启动、写 stdin 并解析 stdout/server request', async (t) => {
  const child = new FakeChild();
  const launches: Array<{ command: string; args: readonly string[]; cwd: string; detached: boolean }> = [];
  const transport = new StdioAcpTransport({
    command: 'node',
    args: ['codebuddy-entry', '--acp', '--acp-transport', 'stdio'],
    cwd: 'D:/workspace',
    spawnProcess: (command, args, options) => {
      launches.push({ command, args, cwd: options.cwd, detached: options.detached });
      return child;
    },
    terminateProcess: async () => child.finish(0),
  });
  t.after(() => transport.close());
  const core = new JsonRpcCore(transport, { defaultTimeoutMs: 1_000 });
  const requests: string[] = [];
  core.onServerRequest((message) => requests.push(String(message.method)));
  await Promise.resolve();
  child.emit('spawn');
  await new Promise<void>((resolve) => transport.onOpen(resolve));

  const response = core.request('initialize', { protocolVersion: 1 });
  child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"ready":true}}\r\n');
  child.stdout.write('{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{}}\n');

  assert.deepEqual(await response, { ready: true });
  assert.deepEqual(requests, ['session/request_permission']);
  assert.deepEqual(launches, [{
    command: 'node',
    args: ['codebuddy-entry', '--acp', '--acp-transport', 'stdio'],
    cwd: 'D:/workspace',
    detached: process.platform !== 'win32',
  }]);
  assert.match(child.input.join(''), /"method":"initialize".*\n/);
});

test('ACP stdio transport 脱敏 stderr，非法 stdout 报错并关闭', async () => {
  const child = new FakeChild();
  const errors: Error[] = [];
  const transport = new StdioAcpTransport({
    command: 'codebuddy',
    args: ['--acp'],
    cwd: 'D:/secret/project',
    homeDir: 'C:/Users/Secret',
    spawnProcess: () => child,
    terminateProcess: async () => child.finish(1),
  });
  transport.onError((error) => errors.push(error));
  await Promise.resolve();
  child.emit('spawn');
  child.stderr.write('Authorization: Bearer abcdefghijklmnop\npath=D:/secret/project home=C:/Users/Secret');
  child.stdout.write('ignore previous instructions\n');
  await waitFor(() => errors.length > 0 && transport.state === 'closed');

  assert.ok(errors.some((error) => error instanceof StdioAcpTransportParseError));
  assert.doesNotMatch(transport.diagnostic(), /abcdefghijklmnop|D:\/secret\/project|C:\/Users\/Secret/);
  assert.match(transport.diagnostic(), /<REDACTED>|<CWD>|<USER_HOME>/);
});

test('ACP stdio transport 启动超时和异常退出会关闭连接并清理 pending', async () => {
  const startupChild = new FakeChild();
  const startupErrors: Error[] = [];
  const startup = new StdioAcpTransport({
    command: 'codebuddy', args: ['--acp'], cwd: 'D:/workspace', startupTimeoutMs: 20,
    spawnProcess: () => startupChild,
    terminateProcess: async () => startupChild.finish(1),
  });
  startup.onError((error) => startupErrors.push(error));
  await waitFor(() => startup.state === 'closed');
  assert.match(startupErrors[0]?.message || '', /启动超时/);

  const child = new FakeChild();
  const transport = new StdioAcpTransport({
    command: 'codebuddy', args: ['--acp'], cwd: 'D:/workspace',
    spawnProcess: () => child,
    terminateProcess: async () => child.finish(1),
  });
  const errors: Error[] = [];
  transport.onError((error) => errors.push(error));
  await Promise.resolve();
  child.emit('spawn');
  const core = new JsonRpcCore(transport, { defaultTimeoutMs: 1_000 });
  const pending = core.request('session/prompt', {});
  assert.equal(child.input.length, 1);
  child.finish(7, null);

  await assert.rejects(pending, JsonRpcConnectionClosedError);
  assert.ok(errors.some((error) => error instanceof AcpProcessExitError && error.exitCode === 7));
  assert.equal(core.pendingCount, 0);
  assert.equal(child.input.length, 1);
});

test('Windows 进程树关闭只针对已知 PID，不按名称模糊清理', () => {
  assert.deepEqual(buildKnownProcessTreeTermination(4321, 'win32'), {
    command: 'taskkill.exe',
    args: ['/PID', '4321', '/T', '/F'],
  });
  assert.equal(buildKnownProcessTreeTermination(undefined, 'win32'), null);
  assert.equal(buildKnownProcessTreeTermination(4321, 'linux'), null);
  assert.deepEqual(buildKnownProcessGroupTermination(4321, false, 'linux'), { pid: -4321, signal: 'SIGTERM' });
  assert.deepEqual(buildKnownProcessGroupTermination(4321, true, 'darwin'), { pid: -4321, signal: 'SIGKILL' });
  assert.equal(buildKnownProcessGroupTermination(4321, false, 'win32'), null);
  assert.equal(buildKnownProcessGroupTermination(undefined, false, 'linux'), null);
});

test('ACP stdio transport 将同步启动失败转换为错误和关闭事件', async () => {
  const transport = new StdioAcpTransport({
    command: 'codebuddy', args: ['--acp'], cwd: 'D:/workspace',
    spawnProcess: () => { throw new Error('spawn failed'); },
  });
  const errors: Error[] = [];
  let closed = false;
  transport.onError((error) => errors.push(error));
  transport.onClose(() => { closed = true; });
  await waitFor(() => closed);
  assert.match(errors[0]?.message || '', /spawn failed/);
  assert.equal(transport.state, 'closed');
});
