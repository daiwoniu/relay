import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  createCodexInstallationCache,
  inspectCodexInstallation,
  inspectCodexSandboxHealth,
  runCodexNpmUpgrade,
} from './lib/codex-maintenance.mjs';

function inspection(overrides = {}) {
  const npmRoot = path.join('C:\\npm', 'node_modules');
  return inspectCodexInstallation({
    platform: 'win32',
    env: { PATH: 'C:\\npm', PATHEXT: '.CMD;.EXE' },
    runCommandSync: (command, args) => command === 'codex'
      ? { status: 0, stdout: 'codex-cli 0.146.0' }
      : { status: 0, stdout: args[0] === 'root' ? npmRoot : 'C:\\npm' },
    resolveCommand: () => path.join('C:\\npm', 'codex.cmd'),
    existsSync: () => true,
    readFileSync: () => JSON.stringify({ name: '@openai/codex', version: '0.146.0' }),
    ...overrides,
  });
}

test('只对命令与包版本一致的 npm 全局 Codex 开放页面升级', () => {
  assert.deepEqual(inspection(), {
    version: '0.146.0',
    installSource: 'npm_global',
    upgradeSupported: true,
    upgradeReason: null,
  });
});

test('Linux 和 macOS 使用 npm prefix 的 bin 目录识别全局 Codex', () => {
  for (const platform of ['linux', 'darwin']) {
    const result = inspectCodexInstallation({
      platform,
      env: { PATH: '/usr/local/bin:/usr/bin' },
      runCommandSync: (command, args) => command === 'codex'
        ? { status: 0, stdout: 'codex-cli 0.146.0' }
        : { status: 0, stdout: args[0] === 'root' ? '/usr/local/lib/node_modules' : '/usr/local' },
      existsSync: (candidate) => candidate === '/usr/local/bin/codex'
        || candidate === '/usr/local/lib/node_modules/@openai/codex/package.json',
      readFileSync: () => JSON.stringify({ name: '@openai/codex', version: '0.146.0' }),
    });
    assert.equal(result.installSource, 'npm_global');
    assert.equal(result.upgradeSupported, true);
  }
});

test('安装检测缓存只在创建和显式刷新时执行外部命令', () => {
  let inspections = 0;
  const cache = createCodexInstallationCache({
    inspect: () => ({ version: `0.14${inspections += 1}.0`, installSource: 'npm_global', upgradeSupported: true, upgradeReason: null }),
  });
  assert.equal(cache.get().version, '0.141.0');
  assert.equal(cache.get().version, '0.141.0');
  assert.equal(inspections, 1);
  assert.equal(cache.refresh().version, '0.142.0');
  assert.equal(inspections, 2);
});

test('命令来源或包版本不一致时降级为只读状态', () => {
  assert.equal(inspection({ resolveCommand: () => 'D:\\custom\\codex.exe' }).upgradeSupported, false);
  assert.match(inspection({ readFileSync: () => JSON.stringify({ version: '0.145.0' }) }).upgradeReason, /不一致/);
});

test('升级器只执行固定 npm 全局包且不接受调用方命令参数', async () => {
  let invocation = null;
  const spawn = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };
  await runCodexNpmUpgrade({
    env: { PATH: 'C:\\npm', PATHEXT: '.CMD;.EXE' },
    cwd: 'G:\\AI\\relay',
    spawn,
    stdio: 'pipe',
  });
  assert.deepEqual(invocation.args.slice(-3), ['install', '-g', '@openai/codex@latest']);
  assert.equal(invocation.options.shell, false);
});

test('启动器使用 pipe 捕获 Codex npm 维护输出', () => {
  const source = fs.readFileSync(new URL('./start.mjs', import.meta.url), 'utf8');
  assert.match(source, /spawnCodexNpmUpgrade\(codexInstallVersion, \{ cwd: ROOT, stdio: 'pipe' \}\)/);
});

function doctorReport(checks) {
  return JSON.stringify({ schemaVersion: 1, overallStatus: 'fail', checks });
}

test('Codex 健康检查忽略认证和网络失败并异步检查去重后的工作区', async () => {
  const calls = [];
  const result = await inspectCodexSandboxHealth({
    platform: 'win32',
    cwd: 'G:\\AI\\relay',
    workspaceRoots: ['G:\\AI\\relay', 'G:\\AI\\Codex\\xinshu', 'g:\\ai\\codex\\xinshu'],
    runCommand: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === 'doctor') return {
        status: 1,
        stdout: doctorReport({
          'auth.credentials': { category: 'auth', status: 'fail', summary: '未登录' },
          'network.provider_reachability': { category: 'reachability', status: 'fail', summary: '网络不可达' },
          'sandbox.provisioning': { category: 'sandbox', status: 'ok', summary: 'elevated sandbox ready' },
        }),
      };
      return { status: 0, stdout: '' };
    },
  });
  assert.deepEqual(result, { ok: true, skipped: false, reason: null });
  assert.deepEqual(calls[0][1], ['doctor', '--json', '--summary']);
  assert.deepEqual(calls[1][1].slice(0, 5), ['sandbox', '--permission-profile', ':workspace', '--cd', 'G:\\AI\\relay']);
  assert.deepEqual(calls[2][1].slice(0, 5), ['sandbox', '--permission-profile', ':workspace', '--cd', 'G:\\AI\\Codex\\xinshu']);
  assert.match(calls[1][1].join(' '), /Get-Location/);
});

test('Codex 健康检查拒绝 sandbox 失败、缺失诊断、损坏 JSON 和任一工作区 canary 失败', async () => {
  const cases = [
    {
      name: 'sandbox 失败',
      doctor: doctorReport({ 'sandbox.provisioning': { category: 'sandbox', status: 'fail', summary: 'provisioning failed' } }),
      canaryStatus: 0,
      reason: /sandbox 诊断全部正常/,
    },
    {
      name: 'sandbox 警告',
      doctor: doctorReport({ 'sandbox.helpers': { category: 'sandbox', status: 'warning', summary: 'helper state uncertain' } }),
      canaryStatus: 0,
      reason: /sandbox 诊断全部正常/,
    },
    { name: '缺少 sandbox 检查', doctor: doctorReport({ installation: { category: 'install', status: 'ok' } }), canaryStatus: 0, reason: /未返回 sandbox 诊断/ },
    { name: 'JSON 损坏', doctor: '{bad', canaryStatus: 0, reason: /无法解析/ },
    {
      name: 'canary 失败',
      doctor: doctorReport({ 'sandbox.provisioning': { category: 'sandbox', status: 'ok', summary: 'ready' } }),
      canaryStatus: 1,
      reason: /无法启动最小命令/,
    },
  ];
  for (const scenario of cases) {
    const result = await inspectCodexSandboxHealth({
      platform: 'win32',
      cwd: 'G:\\AI\\relay',
      workspaceRoots: ['G:\\AI\\Codex\\xinshu'],
      runCommand: async (_command, args) => args[0] === 'doctor'
        ? { status: 1, stdout: scenario.doctor }
        : { status: scenario.canaryStatus, stdout: '' },
    });
    assert.equal(result.ok, false, scenario.name);
    assert.match(result.reason, scenario.reason, scenario.name);
  }
});

test('非 Windows 平台跳过原生 Windows sandbox 健康检查', async () => {
  assert.deepEqual(await inspectCodexSandboxHealth({ platform: 'linux' }), { ok: true, skipped: true, reason: null });
});
