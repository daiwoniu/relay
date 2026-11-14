import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonRpcEnvelope, JsonRpcTransportState } from '../engine/transports/transport.js';
import {
  CODEBUDDY_MODEL_DISCOVERY_ARGS,
  CODEBUDDY_SESSION_ARGS,
  CodeBuddyProcessLimitError,
  CodeBuddyProcessManager,
  resolveCodeBuddyLaunch,
  type ManagedCodeBuddyTransport,
} from './process-manager.js';

class FakeTransport implements ManagedCodeBuddyTransport {
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

class DeferredCloseTransport extends FakeTransport {
  private finishClose: (() => void) | null = null;

  override async closeAndWait(): Promise<void> {
    if (this.state === 'closed') return;
    this.closeCount += 1;
    this.state = 'closing';
    await new Promise<void>((resolve) => { this.finishClose = resolve; });
    this.state = 'closed';
  }

  finish(): void {
    this.finishClose?.();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待 process manager 条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('process manager 同一 session 复用进程，跨 session 独立并受上限保护', async () => {
  const created: FakeTransport[] = [];
  const manager = new CodeBuddyProcessManager({
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
  assert.throws(() => manager.getOrCreate('session-3', 'D:/three'), CodeBuddyProcessLimitError);
  assert.equal(created.length, 2);
  await manager.closeAll();
});

test('process manager 空闲回收、异常关闭移除和显式释放都只影响目标 session', async () => {
  const transports = new Map<string, FakeTransport>();
  const manager = new CodeBuddyProcessManager({
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

test('活动 transport 异常退出后不复用旧进程并允许同 session 重建', async () => {
  const created: FakeTransport[] = [];
  const manager = new CodeBuddyProcessManager({
    maxProcesses: 1,
    idleTimeoutMs: 60_000,
    createTransport: () => {
      const transport = new FakeTransport();
      created.push(transport);
      return transport;
    },
  });
  const first = manager.getOrCreate('session', 'D:/workspace');
  manager.setBusy('session', true);
  await first.closeAndWait();
  await waitFor(() => !manager.has('session'));

  const replacement = manager.getOrCreate('session', 'D:/workspace');

  assert.notEqual(replacement, first);
  assert.equal(created.length, 2);
  await manager.closeAll();
});

test('process manager 活动任务不执行空闲回收，结束活动后重新计时', async () => {
  const manager = new CodeBuddyProcessManager({
    idleTimeoutMs: 30,
    createTransport: () => new FakeTransport(),
  });
  manager.getOrCreate('busy', 'D:/busy');
  assert.equal(manager.setBusy('busy', true), true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(manager.has('busy'), true);
  assert.equal(manager.setBusy('busy', false), true);
  await waitFor(() => !manager.has('busy'));
});

test('process manager 不复用 closing transport', async () => {
  const created: Array<FakeTransport | DeferredCloseTransport> = [];
  const manager = new CodeBuddyProcessManager({
    maxProcesses: 2,
    idleTimeoutMs: 60_000,
    createTransport: () => {
      const transport = created.length === 0 ? new DeferredCloseTransport() : new FakeTransport();
      created.push(transport);
      return transport;
    },
  });
  const first = manager.getOrCreate('session', 'D:/one') as DeferredCloseTransport;
  const closing = manager.release('session');
  await waitFor(() => first.state === 'closing');
  const replacement = manager.getOrCreate('session', 'D:/one');
  assert.notEqual(replacement, first);
  first.finish();
  await closing;
  assert.equal(manager.has('session'), true);
  await manager.closeAll();
});

test('closing transport 在真正退出前继续占用进程上限', async () => {
  const created: Array<FakeTransport | DeferredCloseTransport> = [];
  const manager = new CodeBuddyProcessManager({
    maxProcesses: 1,
    idleTimeoutMs: 60_000,
    createTransport: () => {
      const transport = created.length === 0 ? new DeferredCloseTransport() : new FakeTransport();
      created.push(transport);
      return transport;
    },
  });
  const first = manager.getOrCreate('session', 'D:/one') as DeferredCloseTransport;
  const closing = manager.release('session');
  await waitFor(() => first.state === 'closing');

  assert.equal(manager.size, 1);
  assert.throws(() => manager.getOrCreate('session', 'D:/one'), CodeBuddyProcessLimitError);
  first.finish();
  await closing;
  assert.equal(manager.size, 0);
  manager.getOrCreate('session', 'D:/one');
  assert.equal(manager.size, 1);
  await manager.closeAll();
});

test('closeAll 等待已替换但仍在关闭的 transport', async () => {
  const created: Array<FakeTransport | DeferredCloseTransport> = [];
  const manager = new CodeBuddyProcessManager({
    maxProcesses: 2,
    idleTimeoutMs: 60_000,
    createTransport: () => {
      const transport = created.length === 0 ? new DeferredCloseTransport() : new FakeTransport();
      created.push(transport);
      return transport;
    },
  });
  const first = manager.getOrCreate('session', 'D:/one') as DeferredCloseTransport;
  const firstClosing = manager.release('session');
  await waitFor(() => first.state === 'closing');
  const replacement = manager.getOrCreate('session', 'D:/one') as FakeTransport;
  const closingAll = manager.closeAll();
  await waitFor(() => replacement.state === 'closed');
  first.finish();

  await Promise.all([firstClosing, closingAll]);
  assert.equal(manager.size, 0);
  assert.deepEqual(created.map((transport) => transport.closeCount), [1, 1]);
});

test('旧连接的定向 release 不关闭同 session 的替代 transport', async () => {
  const created: Array<FakeTransport | DeferredCloseTransport> = [];
  const manager = new CodeBuddyProcessManager({
    maxProcesses: 2,
    idleTimeoutMs: 60_000,
    createTransport: () => {
      const transport = created.length === 0 ? new DeferredCloseTransport() : new FakeTransport();
      created.push(transport);
      return transport;
    },
  });
  const first = manager.getOrCreate('session', 'D:/one') as DeferredCloseTransport;
  const firstClosing = manager.release('session', first);
  await waitFor(() => first.state === 'closing');
  const replacement = manager.getOrCreate('session', 'D:/one') as FakeTransport;

  const repeatedRelease = manager.release('session', first);
  assert.equal(replacement.state, 'open');
  first.finish();
  await Promise.all([firstClosing, repeatedRelease]);
  assert.equal(replacement.state, 'open');
  await manager.closeAll();
});

test('process manager 后端退出时并行关闭全部已登记子进程', async () => {
  const created: FakeTransport[] = [];
  const manager = new CodeBuddyProcessManager({
    maxProcesses: 4,
    idleTimeoutMs: 60_000,
    createTransport: () => {
      const transport = new FakeTransport();
      created.push(transport);
      return transport;
    },
  });
  manager.getOrCreate('a', 'D:/a');
  manager.getOrCreate('b', 'D:/b');

  await manager.closeAll();

  assert.equal(manager.size, 0);
  assert.deepEqual(created.map((transport) => transport.closeCount), [1, 1]);
});

test('process manager 只读汇总活动实例启动版本且不暴露 session 信息', async () => {
  const versions = ['2.140.0', '2.140.0', null];
  const manager = new CodeBuddyProcessManager({
    maxProcesses: 4,
    idleTimeoutMs: 60_000,
    readVersion: () => versions.shift() ?? null,
    createTransport: () => new FakeTransport(),
  });
  manager.getOrCreate('secret-session-a', 'D:/secret/a');
  manager.getOrCreate('secret-session-b', 'D:/secret/b');
  manager.getOrCreate('secret-session-c', 'D:/secret/c');

  assert.deepEqual(manager.getInstanceSummary(), {
    activeInstanceCount: 3,
    versions: [{ version: '2.140.0', count: 2 }, { version: null, count: 1 }],
  });
  assert.equal(JSON.stringify(manager.getInstanceSummary()).includes('secret-session'), false);
  await manager.closeAll();
});

test('CodeBuddy 启动解析在 Windows 直接调用 npm 包 Node 入口且不注入 session-id', () => {
  const launch = resolveCodeBuddyLaunch(CODEBUDDY_SESSION_ARGS, {
    platform: 'win32',
    envPath: 'C:\\first;C:\\npm',
    execPath: 'C:\\node.exe',
    exists: (candidate) => candidate.startsWith('C:\\npm'),
  });
  assert.equal(launch.command, 'C:\\node.exe');
  assert.match(launch.args[0], /@tencent-ai[\\/]codebuddy-code[\\/]bin[\\/]codebuddy$/);
  assert.deepEqual(launch.args.slice(1), [
    '--acp', '--acp-transport', 'stdio', '--agent', 'cli', '--permission-mode', 'default',
  ]);
  assert.equal(launch.args.includes('--session-id'), false);
  assert.deepEqual(resolveCodeBuddyLaunch(['--acp'], { platform: 'linux' }), {
    command: 'codebuddy',
    args: ['--acp'],
  });
  assert.throws(() => resolveCodeBuddyLaunch(['--acp'], {
    platform: 'win32',
    envPath: 'C:\\missing',
    exists: () => false,
  }), /CODEBUDDY_CLI_NOT_INSTALLED/);
});

test('CodeBuddy 运行与模型发现固定标准 Agent 和默认权限语义', () => {
  assert.deepEqual([...CODEBUDDY_SESSION_ARGS], [
    '--acp', '--acp-transport', 'stdio', '--agent', 'cli', '--permission-mode', 'default',
  ]);
  assert.deepEqual([...CODEBUDDY_MODEL_DISCOVERY_ARGS], [
    ...CODEBUDDY_SESSION_ARGS, '--tools', '', '--no-session-persistence',
  ]);
});

test('目录发现 transport 无持久化、禁用工具且不进入活动实例计数', async () => {
  const discovery = new FakeTransport();
  const manager = new CodeBuddyProcessManager({
    createTransport: () => new FakeTransport(),
    createDiscoveryTransport: () => discovery,
  });
  assert.equal(manager.createModelDiscoveryTransport('D:/workspace'), discovery);
  assert.equal(manager.size, 0);
  await discovery.closeAndWait();
});
