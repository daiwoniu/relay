import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  dependenciesNeedInstall,
  hashDependencyManifests,
  hashFiles,
  isChinaRegistry,
  normalizeRegistry,
  parseNodeMajor,
  parseSetupArguments,
  readSetupState,
  validateRegistryUrl,
  writeSetupState,
} from './lib/setup-core.mjs';
import { buildCommandInvocation, runCommand, runCommandSync } from './lib/command.mjs';

function createWorkspaceTemp(prefix) {
  const base = path.join(process.cwd(), '.relay-setup', 'test-tmp');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

test('解析 Node 主版本', () => {
  assert.equal(parseNodeMajor('v22.14.0'), 22);
  assert.equal(parseNodeMajor('25.4.0'), 25);
  assert.ok(Number.isNaN(parseNodeMajor('unknown')));
});

test('Windows npm shim 通过 Node 直接执行', () => {
  const env = { PATH: 'C:\\tools', PATHEXT: '.CMD;.EXE', npm_execpath: 'C:\\tools\\npm-cli.js' };
  const originalExists = fs.existsSync;
  fs.existsSync = (candidate) => ['c:\\tools\\npm.cmd', 'c:\\tools\\npm-cli.js'].includes(String(candidate).toLowerCase());
  try {
    const invocation = buildCommandInvocation('npm', ['ci', '--registry=https://example.com/npm/'], { platform: 'win32', env, nodeExecutable: 'node.exe' });
    assert.equal(invocation.command, 'node.exe');
    assert.deepEqual(invocation.args, ['C:\\tools\\npm-cli.js', 'ci', '--registry=https://example.com/npm/']);
    assert.equal(invocation.shell, false);
  } finally {
    fs.existsSync = originalExists;
  }
});

test('Windows CodeBuddy npm shim 通过固定官方 Node 入口执行', () => {
  const env = { PATH: 'C:\\tools', PATHEXT: '.CMD;.EXE' };
  const entrypoint = 'c:\\tools\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy';
  const originalExists = fs.existsSync;
  fs.existsSync = (candidate) => ['c:\\tools\\codebuddy.cmd', entrypoint].includes(String(candidate).toLowerCase());
  try {
    const invocation = buildCommandInvocation('codebuddy', ['--version'], { platform: 'win32', env, nodeExecutable: 'node.exe' });
    assert.equal(invocation.command, 'node.exe');
    assert.deepEqual(invocation.args, [
      'C:\\tools\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy',
      '--version',
    ]);
    assert.equal(invocation.shell, false);
  } finally {
    fs.existsSync = originalExists;
  }
});

test('Windows 未识别的 cmd 包装直接失败而不回退 shell', () => {
  const env = { PATH: 'C:\\tools', PATHEXT: '.CMD' };
  const originalExists = fs.existsSync;
  fs.existsSync = (candidate) => String(candidate).toLowerCase() === 'c:\\tools\\custom.cmd';
  try {
    assert.throws(
      () => buildCommandInvocation('custom', ['argument'], { platform: 'win32', env }),
      /无法安全执行 Windows 命令包装/,
    );
  } finally {
    fs.existsSync = originalExists;
  }
});

test('安全命令解析失败会作为执行错误返回', () => {
  const env = { PATH: 'C:\\tools', PATHEXT: '.CMD' };
  const originalExists = fs.existsSync;
  fs.existsSync = (candidate) => String(candidate).toLowerCase() === 'c:\\tools\\custom.cmd';
  try {
    const result = runCommandSync('custom', [], { platform: 'win32', env });
    assert.match(result.error.message, /无法安全执行 Windows 命令包装/);
  } finally {
    fs.existsSync = originalExists;
  }
});

test('同步命令执行会传递超时限制', () => {
  let receivedOptions;
  const result = runCommandSync('node', ['--version'], {
    timeoutMs: 1234,
    spawnSyncFn: (_command, _args, options) => {
      receivedOptions = options;
      return { status: 0, stdout: 'v22.0.0' };
    },
  });
  assert.equal(result.status, 0);
  assert.equal(receivedOptions.timeout, 1234);
});

test('同步命令超过时限会被终止', () => {
  const result = runCommandSync(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 100 });
  assert.equal(result.error?.code, 'ETIMEDOUT');
});

test('异步命令执行不阻塞事件循环并保留超时边界', async () => {
  let eventLoopAdvanced = false;
  setImmediate(() => { eventLoopAdvanced = true; });
  const completed = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 25)'], { timeoutMs: 1_000 });
  assert.equal(completed.status, 0);
  assert.equal(eventLoopAdvanced, true);

  const timedOut = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 50 });
  assert.match(timedOut.error?.message || '', /命令执行超时/);
});

test('识别并规范化国内 npm registry', () => {
  assert.equal(normalizeRegistry('https://registry.npmjs.org'), 'https://registry.npmjs.org/');
  assert.equal(isChinaRegistry('https://mirrors.cloud.tencent.com/npm/'), true);
  assert.equal(isChinaRegistry('https://registry.npmmirror.com'), true);
  assert.equal(isChinaRegistry('https://registry.npmjs.org/'), false);
});

test('自定义 npm registry 只接受 HTTP 和 HTTPS', () => {
  assert.equal(validateRegistryUrl('https://example.com/npm'), 'https://example.com/npm/');
  assert.throws(() => validateRegistryUrl('file:///tmp/npm'), /只支持 http 或 https/);
  assert.throws(() => validateRegistryUrl('not-a-url'));
});

test('解析 setup 参数', () => {
  assert.deepEqual(parseSetupArguments(['--force', '--registry=china']), {
    force: true,
    checkOnly: false,
    help: false,
    registry: 'china',
    managedRecovery: false,
  });
  assert.deepEqual(parseSetupArguments(['--check-only', '--registry', 'current']), {
    force: false,
    checkOnly: true,
    help: false,
    registry: 'current',
    managedRecovery: false,
  });
  assert.deepEqual(parseSetupArguments(['help']), {
    force: false,
    checkOnly: false,
    help: true,
    registry: null,
    managedRecovery: false,
  });
  assert.equal(parseSetupArguments(['--managed-recovery', '--registry=current']).managedRecovery, true);
  assert.throws(() => parseSetupArguments(['--unknown']), /未知参数/);
});

test('依赖状态只在完整匹配时跳过安装', () => {
  const tempDir = createWorkspaceTemp('relay-setup-');
  try {
    const nodeModulesPath = path.join(tempDir, 'node_modules');
    const critical = path.join(nodeModulesPath, '.bin', 'tsx');
    fs.mkdirSync(path.dirname(critical), { recursive: true });
    fs.writeFileSync(critical, '');

    assert.equal(dependenciesNeedInstall({ force: false, savedFingerprint: 'a', currentFingerprint: 'a', nodeModulesPath, criticalPaths: [critical] }).needed, false);
    assert.equal(dependenciesNeedInstall({ force: false, savedFingerprint: 'legacy', currentFingerprint: 'new', compatibleFingerprints: ['legacy'], nodeModulesPath, criticalPaths: [critical] }).needed, false);
    assert.equal(dependenciesNeedInstall({ force: false, savedFingerprint: 'a', currentFingerprint: 'b', nodeModulesPath, criticalPaths: [critical] }).needed, true);
    assert.equal(dependenciesNeedInstall({ force: true, savedFingerprint: 'a', currentFingerprint: 'a', nodeModulesPath, criticalPaths: [critical] }).needed, true);
    fs.rmSync(critical);
    assert.equal(dependenciesNeedInstall({ force: false, savedFingerprint: 'a', currentFingerprint: 'a', nodeModulesPath, criticalPaths: [critical] }).needed, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('关键工具存在但其运行时依赖缺失时仍要求修复安装', () => {
  const tempDir = createWorkspaceTemp('relay-runtime-dependency-');
  try {
    const nodeModulesPath = path.join(tempDir, 'node_modules');
    const vite = path.join(nodeModulesPath, 'vite', 'bin', 'vite.js');
    const babel = path.join(nodeModulesPath, '@babel', 'core', 'package.json');
    fs.mkdirSync(path.dirname(vite), { recursive: true });
    fs.writeFileSync(vite, '');
    assert.equal(dependenciesNeedInstall({
      force: false,
      savedFingerprint: 'same',
      currentFingerprint: 'same',
      nodeModulesPath,
      criticalPaths: [vite, babel],
    }).needed, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('依赖指纹忽略 scripts 等非依赖字段但识别真实依赖变化', () => {
  const tempDir = createWorkspaceTemp('relay-dependency-fingerprint-');
  try {
    const manifest = path.join(tempDir, 'package.json');
    const lockfile = path.join(tempDir, 'package-lock.json');
    fs.writeFileSync(lockfile, '{"lockfileVersion":3}\n');
    fs.writeFileSync(manifest, JSON.stringify({ scripts: { build: 'vite build' }, dependencies: { react: '19.0.0' } }));
    const first = hashDependencyManifests([manifest, lockfile], ['node-major:22']);
    fs.writeFileSync(manifest, JSON.stringify({ scripts: { build: 'vite build && node budget.mjs' }, dependencies: { react: '19.0.0' } }));
    const scriptsChanged = hashDependencyManifests([manifest, lockfile], ['node-major:22']);
    fs.writeFileSync(manifest, JSON.stringify({ scripts: { build: 'vite build && node budget.mjs' }, dependencies: { react: '19.1.0' } }));
    const dependencyChanged = hashDependencyManifests([manifest, lockfile], ['node-major:22']);
    assert.equal(scriptsChanged, first);
    assert.notEqual(dependencyChanged, first);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('初始化状态和文件指纹可稳定读写', () => {
  const tempDir = createWorkspaceTemp('relay-state-');
  try {
    const manifest = path.join(tempDir, 'package.json');
    const statePath = path.join(tempDir, '.relay-setup', 'setup-state.json');
    fs.writeFileSync(manifest, '{"name":"relay"}\n');
    const first = hashFiles([manifest], ['node-major:22']);
    const second = hashFiles([manifest], ['node-major:22']);
    assert.equal(first, second);

    writeSetupState(statePath, { areas: { server: { fingerprint: first } } });
    assert.equal(readSetupState(statePath).areas.server.fingerprint, first);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
