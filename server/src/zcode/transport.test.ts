import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  ZcodeProcessManager,
  ZcodeNotInstalledError,
} from './process-manager.js';
import {
  ZcodeProcessExitError,
  ZcodeProtocolParseError,
  ZcodeStdioTransport,
  resolveZcodeAppServerEntry,
  type ZcodeChildProcess,
} from './transport.js';

interface FakeChild extends ZcodeChildProcess {
  exitCode: number | null;
  feed(line: string): void;
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
  spawnFail(error: Error): void;
  /** 传输 start() 注册 once('spawn') 之后调用,模拟子进程成功启动。 */
  emitSpawn(): void;
  written: string[];
}

/** 模拟 ZCode app-server 子进程:可编程 stdout 行、错误与退出。 */
function createFakeChild(): FakeChild {
  const source = new EventEmitter();
  const stderr = new EventEmitter();
  const emitter = new EventEmitter();
  const written: string[] = [];
  let currentExitCode: number | null = null;
  const child = {
    pid: 42424,
    get exitCode() { return currentExitCode; },
    stdin: {
      writable: true,
      write: (chunk: string) => { written.push(chunk); return true; },
      end: () => undefined,
    },
    stdout: source,
    stderr,
    kill: (signal?: NodeJS.Signals) => {
      child.exit(null, signal ?? 'SIGKILL');
      return true;
    },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    feed: (line: string) => source.emit('data', Buffer.from(line)),
    exit: (code: number | null, signal: NodeJS.Signals | null = null) => {
      currentExitCode = code;
      source.emit('end');
      emitter.emit('exit', code, signal);
      emitter.emit('close');
    },
    spawnFail: (error: Error) => emitter.emit('error', error),
    emitSpawn: () => emitter.emit('spawn'),
    written,
  };
  return child as unknown as FakeChild;
}

interface Harness {
  transport: ZcodeStdioTransport;
  child: FakeChild;
  messages: Array<Record<string, unknown>>;
  errors: Error[];
  closed: Promise<void>;
  opened: Promise<void>;
}

function createTransport(): Harness {
  const child = createFakeChild();
  const messages: Array<Record<string, unknown>> = [];
  const errors: Error[] = [];
  const transport = new ZcodeStdioTransport({
    executable: 'fake-zcode.cjs',
    cwd: 'D:/workspace/demo',
    spawnProcess: () => child,
  });
  transport.onMessage((message) => messages.push(message as Record<string, unknown>));
  transport.onError((error) => errors.push(error));
  const opened = new Promise<void>((resolve) => transport.onOpen(() => resolve()));
  const closed = new Promise<void>((resolve) => transport.onClose(() => resolve()));
  // start() 经 queueMicrotask 执行;用 setImmediate 确保 once('spawn') 已注册后再模拟启动成功。
  setImmediate(() => child.emitSpawn());
  return { transport, child, messages, errors, closed, opened };
}

test('ZCode 传输 spawn 后转 open、可发送 NDJSON 行,进程死亡传播 closed 与错误', async () => {
  const harness = createTransport();
  await harness.opened;
  assert.equal(harness.transport.state, 'open');

  harness.transport.send({ id: 1, method: 'session/list', params: {} });
  assert.deepEqual(JSON.parse(harness.child.written[0]), { id: 1, method: 'session/list', params: {} });

  harness.child.exit(null);
  await harness.closed;
  assert.equal(harness.transport.state, 'closed');
  assert.ok(harness.errors.some((error) => error instanceof ZcodeProcessExitError));

  // 关闭后发送抛错
  assert.throws(() => harness.transport.send({ id: 2, method: 'session/list' }));
});

test('ZCode 传输分发应答、事件与无效 JSON', async () => {
  const harness = createTransport();
  await harness.opened;

  const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
    const off = harness.transport.onMessage((message) => {
      if (message.id === 7) {
        off();
        if (message.error) reject(new Error(String((message.error as { message?: string }).message)));
        else resolve(message.result as Record<string, unknown>);
      }
    });
  });
  harness.transport.send({ id: 7, method: 'session/create', params: {} });
  harness.child.feed('{"id":7,"result":{"sessionId":"sess_x"}}\n');
  const result = await reply;
  assert.deepEqual(result, { sessionId: 'sess_x' });

  // 事件通知(仅 method)
  harness.child.feed('{"method":"session/event","params":{"type":"turn.completed"}}\n');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const event = harness.messages.find((message) => message.method === 'session/event');
  assert.ok(event);

  // 非法 JSON:触发解析错误并强杀传输
  harness.child.feed('not-json\n');
  await harness.closed;
  assert.ok(harness.errors.some((error) => error instanceof ZcodeProtocolParseError));
});

test('ZCode close timeout and child errors retain physical ownership until a real close event', async context => {
  const harness = createTransport(); await harness.opened;
  harness.child.kill = () => true; // The OS accepted the request, but has not confirmed process exit.
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const closing = harness.transport.closeAndWait(true);
    const rejected = assert.rejects(closing, /ZCODE_PROCESS_CLOSE_UNCONFIRMED/);
    context.mock.timers.tick(2000); await rejected;
    assert.equal(harness.transport.state, 'closing');
    harness.child.spawnFail(Error('synthetic process error'));
    assert.equal(harness.transport.state, 'closing');
    let closed = false;
    const retry = harness.transport.closeAndWait(true).then(() => { closed = true; });
    await Promise.resolve(); assert.equal(closed, false);
    harness.child.exit(0); await retry;
    assert.equal(harness.transport.state, 'closed');
  } finally { context.mock.timers.reset(); harness.child.exit(0); }
});

test('resolveZcodeAppServerEntry 优先显式环境变量并探测安装路径', () => {
  const existing = (candidate: string) => candidate.includes('explicit.cjs') || candidate.includes('Program Files');
  const explicit = resolveZcodeAppServerEntry({
    platform: 'win32',
    env: { RELAY_ZCODE_EXECUTABLE: 'D:/tools/explicit.cjs' },
    exists: existing,
  });
  assert.equal(explicit, 'D:/tools/explicit.cjs');

  const discovered = resolveZcodeAppServerEntry({
    platform: 'win32',
    env: {},
    exists: existing,
  });
  assert.ok(discovered?.includes('Program Files'));

  assert.equal(resolveZcodeAppServerEntry({ platform: 'win32', env: {}, exists: () => false }), null);

  // 显式路径不存在时返回 null(视为未安装),不回退到探测路径
  assert.equal(resolveZcodeAppServerEntry({
    platform: 'win32',
    env: { RELAY_ZCODE_EXECUTABLE: 'D:/tools/gone.cjs' },
    exists: existing,
  }), null);
});

test('进程管理器懒启动单例、引用计数与未安装错误', async () => {
  let created = 0;
  const manager = new ZcodeProcessManager({
    env: {},
    exists: () => false,
    createTransport: () => {
      created += 1;
      // 借用真实 transport 逻辑但用 fake spawn
      const harness = createTransportHarness();
      return harness.transport;
    },
  });
  assert.equal(manager.hasLiveProcess, false);

  const first = manager.acquire('sess-1', 'D:/ws');
  const second = manager.acquire('sess-2', 'D:/ws');
  assert.equal(created, 1);
  assert.equal(manager.refCount, 2);
  assert.ok(first === second);

  // 不同工作区各自持有独立进程,互不复用也不阻断
  const other = manager.acquire('sess-3', 'D:/other-workspace');
  assert.equal(created, 2);
  assert.ok(other !== first);
  assert.equal(manager.size, 2);
  assert.equal(manager.refCount, 3);

  manager.release('sess-1');
  assert.equal(manager.refCount, 2);
  manager.release('sess-2');
  manager.release('sess-3');
  assert.equal(manager.refCount, 0);

  // 未安装时 acquire 抛稳定错误
  const absent = new ZcodeProcessManager({ env: {}, exists: () => false });
  assert.throws(() => absent.acquire('sess-x', 'D:/ws'), (error: unknown) => error instanceof ZcodeNotInstalledError);

  await manager.shutdown();
  // 管理器 shutdown 后 transport 已 closed;显式退出避免残留句柄拖住测试进程。
  setImmediate(() => process.exit(0));
});

function createTransportHarness(): { transport: ZcodeStdioTransport } {
  const child = createFakeChild();
  const transport = new ZcodeStdioTransport({
    executable: 'fake-zcode.cjs',
    cwd: 'D:/ws',
    spawnProcess: () => child,
  });
  setImmediate(() => child.emitSpawn());
  return { transport };
}
