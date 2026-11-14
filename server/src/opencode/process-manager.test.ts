import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonRpcEnvelope, JsonRpcTransportState } from '../engine/transports/transport.js';
import {
  OPENCODE_MODEL_DISCOVERY_ARGS,
  OPENCODE_SESSION_ARGS,
  OpenCodeProcessLimitError,
  OpenCodeProcessManager,
  resolveOpenCodeLaunch,
  type ManagedOpenCodeTransport,
} from './process-manager.js';

class FakeTransport implements ManagedOpenCodeTransport {
  state: JsonRpcTransportState = 'open';
  closeCount = 0;
  private readonly closeListeners = new Set<() => void>();

  send(_message: JsonRpcEnvelope): void {}
  close(): void { void this.closeAndWait(); }
  terminate(): void { void this.closeAndWait(); }
  onOpen(listener: () => void): () => void { queueMicrotask(listener); return () => undefined; }
  onMessage(): () => void { return () => undefined; }
  onError(): () => void { return () => undefined; }
  onClose(listener: () => void): () => void { this.closeListeners.add(listener); return () => this.closeListeners.delete(listener); }
  diagnostic(): string { return ''; }
  async closeAndWait(): Promise<void> {
    if (this.state === 'closed') return;
    this.closeCount += 1;
    this.state = 'closed';
    for (const listener of this.closeListeners) listener();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待 process manager 条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('OpenCode 启动解析在 Windows 定位二进制并传 acp 参数，跨平台回退裸命令', () => {
  const launch = resolveOpenCodeLaunch(OPENCODE_SESSION_ARGS, {
    platform: 'win32',
    envPath: 'C:\\first;C:\\global\\npm',
    exists: (candidate) => candidate === 'C:\\global\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe',
  });
  assert.equal(launch.command, 'C:\\global\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe');
  assert.deepEqual(launch.args, ['acp']);
  assert.deepEqual(resolveOpenCodeLaunch(['acp'], { platform: 'linux' }), {
    command: 'opencode',
    args: ['acp'],
  });
  assert.throws(() => resolveOpenCodeLaunch(['acp'], {
    platform: 'win32',
    envPath: 'C:\\missing',
    exists: () => false,
  }), /OPENCODE_CLI_NOT_INSTALLED/);
});

test('OpenCode 启动解析优先 PATH 上的直接 opencode.exe', () => {
  const launch = resolveOpenCodeLaunch(['acp'], {
    platform: 'win32',
    envPath: 'C:\\custom',
    exists: (candidate) => candidate === 'C:\\custom\\opencode.exe',
  });
  assert.equal(launch.command, 'C:\\custom\\opencode.exe');
  assert.deepEqual(launch.args, ['acp']);
});

test('OpenCode Windows npm 安装布局优先真实 exe，不误启动 cmd 转发壳', () => {
  const launch = resolveOpenCodeLaunch(['acp'], {
    platform: 'win32', envPath: 'C:\\npm',
    exists: (candidate) => candidate === 'C:\\npm\\opencode.cmd'
      || candidate === 'C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe',
  });
  assert.equal(launch.command, 'C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe');
});

test('OpenCode 运行与模型发现都用 acp 子命令', () => {
  assert.deepEqual([...OPENCODE_SESSION_ARGS], ['acp']);
  assert.deepEqual([...OPENCODE_MODEL_DISCOVERY_ARGS], ['acp']);
});

test('OpenCode process manager 同一 session 复用进程，跨 session 独立并受上限保护', async () => {
  const created: FakeTransport[] = [];
  const manager = new OpenCodeProcessManager({
    maxProcesses: 2,
    idleTimeoutMs: 60_000,
    createTransport: () => {
      const transport = new FakeTransport();
      created.push(transport);
      return transport;
    },
  });

  const first = manager.getOrCreate('session-1', 'D:/one');
  assert.equal(manager.getOrCreate('session-1', 'D:/one'), first);
  const second = manager.getOrCreate('session-2', 'D:/two');
  assert.notEqual(second, first);
  assert.equal(manager.size, 2);
  assert.throws(() => manager.getOrCreate('session-3', 'D:/three'), OpenCodeProcessLimitError);
  assert.equal(created.length, 2);
  await manager.closeAll();
});

test('OpenCode process manager 空闲回收、异常关闭移除和显式释放只影响目标 session', async () => {
  const transports = new Map<string, FakeTransport>();
  const manager = new OpenCodeProcessManager({
    maxProcesses: 4,
    idleTimeoutMs: 200,
    createTransport: (_cwd, sessionId) => {
      const transport = new FakeTransport();
      transports.set(sessionId, transport);
      return transport;
    },
  });
  manager.getOrCreate('idle', 'D:/idle');
  manager.getOrCreate('active', 'D:/active');
  await new Promise((resolve) => setTimeout(resolve, 100));
  manager.touch('active');
  await waitFor(() => !manager.has('idle'));
  assert.equal(transports.get('idle')?.closeCount, 1);
  assert.equal(manager.has('active'), true);

  await transports.get('active')?.closeAndWait();
  await waitFor(() => !manager.has('active'));

  manager.getOrCreate('release', 'D:/release');
  await manager.release('release');
  assert.equal(manager.has('release'), false);
  assert.equal(transports.get('release')?.closeCount, 1);
});

test('目录发现 transport 使用 acp 子命令且不进入活动实例计数', async () => {
  const discovery = new FakeTransport();
  const manager = new OpenCodeProcessManager({
    createTransport: () => new FakeTransport(),
    createDiscoveryTransport: () => discovery,
  });
  assert.equal(manager.createModelDiscoveryTransport('D:/workspace'), discovery);
  assert.equal(manager.size, 0);
  await discovery.closeAndWait();
});
