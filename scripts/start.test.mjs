import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  OWNERSHIP_NOTICE,
  LOGS_NOTICE,
  captureCtrlC,
  createLauncherOutputWriter,
  checkServices,
  getCapturedOutput,
  getOrSpawnOwnedService,
  getLanAccessUrls,
  watchLanAccessUrls,
  loadDotEnv,
  reportExistingServices,
  spawnService,
  stopProcessTree,
  validateRuntimePrerequisites,
} from './lib/launcher-core.mjs';
import { formatPublicAccessStatus, parseRelayConfig } from './lib/relay-config.mjs';
import { createBackendCodexEnvironment, createCodexServiceDefinition } from './lib/codex-service.mjs';
import { createServiceFileLogger } from './lib/service-file-logging.mjs';
import * as launcherCore from './lib/launcher-core.mjs';

const services = [
  { name: 'A', port: 1001, healthUrl: 'http://a', displayUrl: 'ws://a' },
  { name: 'B', port: 1002, healthUrl: 'http://b', displayUrl: 'http://b' },
];
const CONFIG_ENDPOINTS = 'BACKEND_LISTEN_HOST=0.0.0.0\nBACKEND_LISTEN_PORT=9181\nFRONTEND_LISTEN_HOST=0.0.0.0\nFRONTEND_LISTEN_PORT=9081';

test('启动器帮助和错误输出的每个非空行都有本地时间前缀', () => {
  for (const args of [['help'], ['--verbose']]) {
    const result = spawnSync(process.execPath, ['scripts/start.mjs', ...args], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
    const lines = `${result.stdout}${result.stderr}`.split(/\r?\n/).filter((line) => line.trim());
    assert.ok(lines.length > 0);
    for (const line of lines) assert.match(line, /^\[\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /);
    if (args[0] === '--verbose') assert.equal(result.status, 1);
  }
});

test('终端输出保留已有时间前缀且只给普通行补时间', () => {
  const script = [
    "import { installTerminalTimestamps } from './scripts/lib/terminal-timestamps.mjs';",
    'installTerminalTimestamps();',
    "console.log('[09-30 13:41:11] 收到用户 admin 的升级 CodeBuddy请求');",
    "console.log('普通启动消息');",
    "console.error('[09-30 13:41:12] 已带时间的错误');",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^\[09-30 13:41:11\] 收到用户 admin 的升级 CodeBuddy请求\r?\n/);
  assert.match(result.stdout, /\r?\n\[\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 普通启动消息\r?\n/);
  assert.equal(result.stderr.trim(), '[09-30 13:41:12] 已带时间的错误');
});

test('受管服务重启改变登记顺序后仍先停引擎、再停前端、最后停后端', () => {
  const entries = [
    { service: { id: 'codex' } },
    { service: { id: 'backend' } },
    { service: { id: 'frontend' } },
  ];
  assert.deepEqual(launcherCore.orderOwnedServicesForStop(entries).map(({ service }) => service.id), ['codex', 'frontend', 'backend']);
});

test('后端恢复先唤醒 Codex 时，启动器复用已登记子进程', () => {
  const service = { id: 'codex', name: 'Codex' };
  const child = { pid: 22492 };
  const owned = new Map();
  let spawnCount = 0;
  let handlerCount = 0;
  const spawnChild = () => { spawnCount += 1; return child; };
  const onChildCreated = () => { handlerCount += 1; };

  assert.deepEqual(getOrSpawnOwnedService(service, owned, spawnChild, onChildCreated, () => 1), { child, reused: false });
  assert.deepEqual(getOrSpawnOwnedService(service, owned, spawnChild, onChildCreated, () => 2), { child, reused: true });
  assert.equal(owned.get('codex').startedAt, 1);
  assert.equal(spawnCount, 1);
  assert.equal(handlerCount, 1);
});

test('启动器输出同时进入终端和文件事件日志', () => {
  const events = [];
  const stdout = [];
  const stderr = [];
  const writer = createLauncherOutputWriter({
    writeEvent: (line) => events.push(line),
    write: (line) => stdout.push(line),
    writeError: (line) => stderr.push(line),
  });
  writer.write('网络变化：\n  Wi-Fi: http://192.168.1.2:9081');
  writer.writeError('启动失败：测试');
  assert.deepEqual(events, ['网络变化：', '  Wi-Fi: http://192.168.1.2:9081', '启动失败：测试']);
  assert.deepEqual(stdout, ['网络变化：\n  Wi-Fi: http://192.168.1.2:9081']);
  assert.deepEqual(stderr, ['启动失败：测试']);
});

test('纯检查模式不会启动服务并输出实际地址', async () => {
  const output = [];
  let calls = 0;
  const exitCode = await checkServices(services, async () => {
    calls += 1;
    return true;
  }, (line) => output.push(line));
  assert.equal(exitCode, 0);
  assert.equal(calls, 2);
  assert.equal(output[1], '');
  assert.ok(output.some((line) => line.includes('地址: ws://a')));
  assert.ok(output.some((line) => line.includes('地址: http://b')));
  assert.equal(output.at(-1), '');
});

test('纯检查模式对缺失服务返回非零', async () => {
  const output = [];
  const exitCode = await checkServices(services, async (url) => url !== 'http://b', (line) => output.push(line));
  assert.equal(exitCode, 1);
  assert.match(output.at(-2), /^检查完成，未运行：/);
  assert.ok(output.at(-2).includes('B'));
  assert.doesNotMatch(output.at(-2), /失败/);
  assert.equal(output.at(-1), '');
});

test('所有权提示说明 Ctrl+C 只停止本次启动器拉起的服务', () => {
  assert.match(OWNERSHIP_NOTICE, /Ctrl\+C 停止本次启动器拉起的服务/);
});

test('默认启动摘要明确文件日志入口', () => {
  assert.equal(LOGS_NOTICE, '详细日志：logs/');
});

test('启动状态区分关闭、精确地址和危险通配', () => {
  const parse = (addresses) => parseRelayConfig(`CODEX_HOST=127.0.0.1\nCODEX_PORT=9281\n${CONFIG_ENDPOINTS}\nPUBLIC_ALLOWED_ADDRESSES=${addresses}`);
  assert.deepEqual(formatPublicAccessStatus(parse('')), ['公网访问：未启用']);
  assert.match(formatPublicAccessStatus(parse('relay.example:41423')).join('\n'), /https:\/\/relay\.example:41423/);
  assert.match(formatPublicAccessStatus(parse('0.0.0.0')).join('\n'), /警告/);
});

test('Codex 服务定义和后端环境统一使用配置端点', () => {
  const config = parseRelayConfig(`CODEX_HOST=127.0.0.1\nCODEX_PORT=9281\n${CONFIG_ENDPOINTS}\nPUBLIC_ALLOWED_ADDRESSES=`);
  const service = createCodexServiceDefinition('G:\\relay', config.codex);
  assert.equal(service.port, 9281);
  assert.equal(service.healthUrl, 'http://127.0.0.1:9281/readyz');
  assert.equal(service.displayUrl, 'ws://127.0.0.1:9281');
  assert.deepEqual(service.args, ['app-server', '--listen', 'ws://127.0.0.1:9281']);
  assert.equal(service.terminateTreeFirst, true);
  assert.deepEqual(createBackendCodexEnvironment(config.codex), {
    CODEX_WS_URL: 'ws://127.0.0.1:9281',
    CODEX_READY_URL: 'http://127.0.0.1:9281/readyz',
  });
});

test('已有服务时使用启动前状态文案并返回退出码', async () => {
  const output = [];
  const listeningPids = new Map([[1001, [1234]], [1002, [5678]]]);
  const allRunning = await reportExistingServices(services, async () => true, (line) => output.push(line), listeningPids, () => true);
  assert.equal(allRunning, 0);
  assert.ok(output.some((line) => line.includes('启动前服务检查')));
  assert.equal(output[1], '');
  assert.ok(output.some((line) => line.includes('A：启动前已在运行（PID 1234）')));
  assert.ok(output.some((line) => line.includes('本命令执行前已经运行')));
  assert.ok(output.some((line) => line.includes('本次未启动任何服务')));
  assert.ok(output.some((line) => line.includes('npm run stop')));
  assert.ok(output.some((line) => line.includes('npm run restart')));
  assert.equal(output.at(-1), '');
  assert.equal(output.some((line) => line.includes('就绪')), false);

  const partial = await reportExistingServices(services, async (url) => url === 'http://a', () => {});
  assert.equal(partial, 1);
  const none = await reportExistingServices(services, async () => false, () => {});
  assert.equal(none, null);
});

test('启动前识别未就绪的 Windows 幽灵监听并阻止继续启动', async () => {
  const output = [];
  const listeningPids = new Map([[1001, [12916]], [1002, []]]);
  const exitCode = await reportExistingServices(
    services,
    async () => false,
    (line) => output.push(line),
    listeningPids,
    () => false,
  );
  assert.equal(exitCode, 1);
  assert.ok(output.some((line) => line.includes('端口 1001 被异常占用')));
  assert.ok(output.some((line) => line.includes('PID 12916')));
  assert.ok(output.some((line) => line.includes('Windows 幽灵监听')));
  assert.ok(output.some((line) => line.includes('自动选择空闲端口')));
  assert.equal(output.some((line) => line.includes('npm run restart')), false);
});

test('交互终端接管 Ctrl+C 并在清理后恢复终端模式', () => {
  const input = new EventEmitter();
  Object.assign(input, {
    isTTY: true,
    isRaw: false,
    paused: true,
    modes: [],
    setRawMode(mode) {
      this.isRaw = mode;
      this.modes.push(mode);
    },
    isPaused() {
      return this.paused;
    },
    resume() {
      this.paused = false;
    },
    pause() {
      this.paused = true;
    },
  });
  let interrupts = 0;

  const restore = captureCtrlC(input, () => { interrupts += 1; });
  input.emit('data', Buffer.from([3]));
  restore();
  restore();

  assert.equal(interrupts, 1);
  assert.deepEqual(input.modes, [true, false]);
  assert.equal(input.paused, true);
  assert.equal(input.listenerCount('data'), 0);
});

test('非交互输入不接管 Ctrl+C', () => {
  const input = new EventEmitter();
  Object.assign(input, { isTTY: false });
  const restore = captureCtrlC(input, () => assert.fail('不应触发'));
  restore();
  assert.equal(input.listenerCount('data'), 0);
});

test('局域网地址按网卡列出并过滤回环、公网和重复地址', () => {
  const results = getLanAccessUrls(9081, {
    'Wi-Fi': [
      { family: 'IPv4', internal: false, address: '192.168.43.13' },
      { family: 'IPv6', internal: false, address: 'fe80::1' },
    ],
    VPN: [{ family: 4, internal: false, address: '192.168.101.39' }],
    Duplicate: [{ family: 'IPv4', internal: false, address: '192.168.43.13' }],
    Public: [{ family: 'IPv4', internal: false, address: '8.8.8.8' }],
    Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
  });
  assert.deepEqual(results, [
    { name: 'Wi-Fi', address: '192.168.43.13', url: 'http://192.168.43.13:9081' },
    { name: 'VPN', address: '192.168.101.39', url: 'http://192.168.101.39:9081' },
  ]);
});

test('默认模式捕获子服务输出供失败诊断', async () => {
  const child = spawnService({
    command: process.execPath,
    args: ['-e', 'console.log("captured relay output")'],
    cwd: process.cwd(),
  });
  await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  assert.match(getCapturedOutput(child), /captured relay output/);
});

test('子服务输出只进入接收器和故障捕获，不向终端转发', async () => {
  const chunks = [];
  const forwarded = [];
  const child = spawnService({
    command: process.execPath,
    args: ['-e', 'console.log("logged stdout"); console.error("logged stderr")'],
    cwd: process.cwd(),
    id: 'backend',
  }, {
    verbose: true,
    onOutput: (service, channel, chunk) => chunks.push([service.id, channel, chunk.toString()]),
    stdout: { write: (chunk) => forwarded.push(['stdout', chunk.toString()]) },
    stderr: { write: (chunk) => forwarded.push(['stderr', chunk.toString()]) },
  });
  await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  assert.ok(chunks.some(([id, channel, value]) => id === 'backend' && channel === 'stdout' && value.includes('logged stdout')));
  assert.ok(chunks.some(([, channel, value]) => channel === 'stderr' && value.includes('logged stderr')));
  assert.match(getCapturedOutput(child), /logged stdout|logged stderr/);
  assert.equal(forwarded.length, 0);
});

test('Windows 受管子服务隐藏独立控制台窗口', () => {
  let invocation;
  const child = new EventEmitter();
  Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter() });
  spawnService({ command: 'node', args: ['service.js'], cwd: process.cwd() }, {
    spawnFn: (...args) => { invocation = args; return child; },
  });
  if (process.platform === 'win32') assert.equal(invocation[2].windowsHide, true);
});

test('子服务输出实际写入文件日志', async () => {
  for (const sample of ['first', 'second']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-launcher-log-'));
    const logger = createServiceFileLogger({ root, warn: () => {} });
    const child = spawnService({
      command: process.execPath,
      args: ['-e', `console.log("file mode ${sample}")`],
      cwd: process.cwd(),
      id: 'backend',
    }, {
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      onOutput: (service, channel, chunk) => logger.writeServiceChunk(service.id, channel, chunk),
    });
    try {
      await new Promise((resolve, reject) => {
        child.once('exit', resolve);
        child.once('error', reject);
      });
      logger.flushService('backend');
      await logger.close();
      assert.match(fs.readFileSync(logger.currentRunLogPath, 'utf8'), new RegExp(`file mode ${sample}`));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('只有标记 ipc 的 Node 子服务增加 IPC 通道', async () => {
  const ipcChild = spawnService({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(),
    ipc: true,
  });
  const regularChild = spawnService({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(),
  });
  try {
    assert.equal(typeof ipcChild.send, 'function');
    assert.equal(regularChild.send, undefined);
  } finally {
    await Promise.all([stopProcessTree(ipcChild), stopProcessTree(regularChild)]);
  }
});

test('Windows 使用 taskkill 清理本次启动的进程树', async () => {
  const calls = [];
  const signals = [];
  const child = new EventEmitter();
  Object.assign(child, { pid: 1234, exitCode: null, signalCode: null });
  await stopProcessTree(child, {
    platform: 'win32',
    graceTimeoutMs: 1,
    killFn: (pid, signal) => signals.push([pid, signal]),
    runTaskkillFn: async (pid) => {
      calls.push({ command: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] });
      child.exitCode = 1;
      return { status: 0, error: null };
    },
  });
  assert.deepEqual(signals, [[1234, 'SIGTERM']]);
  assert.deepEqual(calls, [{ command: 'taskkill', args: ['/PID', '1234', '/T', '/F'] }]);
});

test('Windows Codex 停止时先清理包装进程和原生子进程', async () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 1235, exitCode: null, signalCode: null, terminateTreeFirst: true });
  const calls = [];
  await stopProcessTree(child, {
    platform: 'win32',
    killFn: () => { throw new Error('不应单独停止包装进程'); },
    runTaskkillFn: async (pid) => {
      calls.push(pid);
      child.exitCode = 1;
      return { status: 0, error: null };
    },
  });
  assert.deepEqual(calls, [1235]);
});

test('Windows taskkill 失败会向上报告', async () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 4321, exitCode: null, signalCode: null });
  await assert.rejects(
    stopProcessTree(child, {
      platform: 'win32',
      killFn: () => {},
      runTaskkillFn: async () => ({ status: 1, error: null }),
      graceTimeoutMs: 1,
      retryTimeoutMs: 1,
    }),
    /taskkill 退出码 1/,
  );
});

test('Codex树清理遇到taskkill 128时区分已退出竞态与真正失败', async () => {
  const exited=new EventEmitter();
  Object.assign(exited,{pid:1235,exitCode:null,signalCode:null,terminateTreeFirst:true});
  await stopProcessTree(exited,{platform:'win32',runTaskkillFn:async()=>{
    exited.exitCode=0;return{status:128,error:null};
  }});
  const alive=new EventEmitter();
  Object.assign(alive,{pid:1236,exitCode:null,signalCode:null,terminateTreeFirst:true});
  await assert.rejects(stopProcessTree(alive,{platform:'win32',retryTimeoutMs:1,
    runTaskkillFn:async()=>({status:128,error:null})}),/taskkill 退出码 128/);
});

test('Windows 无法发送终止信号时立即回退 taskkill', async () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 9753, exitCode: null, signalCode: null });
  let taskkillCalled = false;
  await stopProcessTree(child, {
    platform: 'win32',
    killFn: () => { throw Object.assign(new Error('拒绝访问'), { code: 'EPERM' }); },
    runTaskkillFn: async () => {
      taskkillCalled = true;
      child.exitCode = 0;
      return { status: 0, error: null };
    },
  });
  assert.equal(taskkillCalled, true);
});

test('Windows 子服务已响应 Ctrl+C 时不再调用 taskkill', async () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 2468, exitCode: null, signalCode: null });
  let taskkillCalled = false;
  const signals = [];
  await stopProcessTree(child, {
    platform: 'win32',
    graceTimeoutMs: 100,
    killFn: (pid, signal) => {
      signals.push([pid, signal]);
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
    },
    runTaskkillFn: async () => {
      taskkillCalled = true;
      return { status: 0, error: null };
    },
  });
  assert.deepEqual(signals, [[2468, 'SIGTERM']]);
  assert.equal(taskkillCalled, false);
});

test('真实停止本次启动的子进程', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await stopProcessTree(child, { exitTimeoutMs: 5000 });
  assert.notEqual(child.exitCode ?? child.signalCode, null);
});

test('dotenv 保留已有环境变量并解析引号', () => {
  const directory = path.join(process.cwd(), '.relay-setup', 'test-tmp');
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `dotenv-${process.pid}.env`);
  try {
    fs.writeFileSync(filePath, '# 注释\nEXISTING=file\nNEW_VALUE="hello world"\nINVALID\n');
    const environ = { EXISTING: 'process' };
    loadDotEnv(filePath, environ);
    assert.equal(environ.EXISTING, 'process');
    assert.equal(environ.NEW_VALUE, 'hello world');
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('启动前缺少关键依赖时提示先初始化', () => {
  assert.throws(() => validateRuntimePrerequisites(['Z:\\missing-relay-file']), /npm run setup/);
});
