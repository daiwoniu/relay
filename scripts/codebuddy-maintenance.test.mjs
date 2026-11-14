import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CODEBUDDY_QUOTA_EXIT_CODE,
  assertCodeBuddyCancellationResult,
  assertCodeBuddyPromptCompleted,
  classifyCodeBuddyPermissionProbe,
  codeBuddyProbeExitCode,
  createCodeBuddySetupState,
  createCodeBuddyReadinessProbe,
  inspectCodeBuddyInstallation,
  spawnCodeBuddyNpmInstall,
} from './lib/codebuddy-maintenance.mjs';

const quotaRefusal = {
  stopReason: 'refusal',
  _meta: {
    'codebuddy.ai/outcome': 'FAILED_MODEL_REQUEST',
    'codebuddy.ai/errorMessage': JSON.stringify({
      code: -32003,
      message: 'Quota exceeded: 429 额度已用尽 (request-private-id)',
      data: { statusCode: 429, code: 14018, category: 'quota' },
    }),
  },
};

test('CodeBuddy 权限探针遇到额度拒绝时给出脱敏原因并阻断 readiness', () => {
  assert.equal(CODEBUDDY_QUOTA_EXIT_CODE, 42);
  assert.equal(classifyCodeBuddyPermissionProbe(true, { stopReason: 'cancelled' }), 'requested');
  assert.throws(
    () => classifyCodeBuddyPermissionProbe(true, quotaRefusal),
    /额度已用尽.*429/,
  );
  assert.throws(
    () => classifyCodeBuddyPermissionProbe(false, quotaRefusal),
    (error) => error.code === 'CODEBUDDY_QUOTA_EXHAUSTED' && /额度已用尽.*429/.test(error.message) && !error.message.includes('request-private-id'),
  );
  assert.throws(
    () => classifyCodeBuddyPermissionProbe(false, { stopReason: 'refusal' }),
    /模型请求被拒绝/,
  );
  assert.throws(
    () => classifyCodeBuddyPermissionProbe(false, { stopReason: 'end_turn' }),
    /未收到 session\/request_permission.*end_turn/,
  );
  assert.throws(
    () => classifyCodeBuddyPermissionProbe(false, undefined),
    /未收到 session\/request_permission.*unknown/,
  );
});

test('CodeBuddy 取消探针遇到额度拒绝时不泄露原始响应', () => {
  assert.doesNotThrow(() => assertCodeBuddyCancellationResult({ stopReason: 'cancelled' }));
  assert.throws(
    () => assertCodeBuddyCancellationResult(quotaRefusal),
    (error) => error.code === 'CODEBUDDY_QUOTA_EXHAUSTED' && /额度已用尽.*429/.test(error.message) && !error.message.includes('request-private-id'),
  );
});

test('CodeBuddy 探针仅对结构化额度错误使用专用退出码', () => {
  let quotaError;
  try { assertCodeBuddyCancellationResult(quotaRefusal); } catch (error) { quotaError = error; }
  assert.equal(codeBuddyProbeExitCode(quotaError), 42);
  assert.equal(codeBuddyProbeExitCode(new Error('generic failure')), 1);
});

test('CodeBuddy 轻量重新检测必须确认模型正常完成，额度拒绝不能恢复可用性', () => {
  assert.doesNotThrow(() => assertCodeBuddyPromptCompleted({ stopReason: 'end_turn' }));
  assert.throws(
    () => assertCodeBuddyPromptCompleted(quotaRefusal),
    (error) => error.code === 'CODEBUDDY_QUOTA_EXHAUSTED' && /额度已用尽/.test(error.message),
  );
  assert.throws(() => assertCodeBuddyPromptCompleted({ stopReason: 'refusal' }), /模型请求被拒绝/);
});

test('CodeBuddy 额度延期持久保留新版事实并阻断会话，成功复验清除标记', () => {
  const installed = { version: '2.155.0', installSource: 'npm_global' };
  const deferred = createCodeBuddySetupState(installed, false, 'provider_quota', '2026-09-30T06:00:00.000Z');
  assert.deepEqual(deferred, {
    ideInstalled: false, cliInstalled: true, authReady: true, acpSupported: true,
    protocolReady: true, available: false, version: '2.155.0', installSource: 'npm_global',
    readinessCheckedAt: null, readinessFailure: 'provider_quota',
  });
  const ready = createCodeBuddySetupState(installed, true, null, '2026-09-30T06:01:00.000Z');
  assert.equal(ready.available, true);
  assert.equal(ready.readinessCheckedAt, '2026-09-30T06:01:00.000Z');
  assert.equal(ready.readinessFailure, null);
});

test('CodeBuddy 只认可命令与官方 npm 全局包一致的安装', () => {
  const result = inspectCodeBuddyInstallation({
    platform: 'win32', env: {},
    runCommandSync: (command, args) => ({ status: 0, stdout: args[0] === 'root' ? 'C:\\npm\\node_modules' : 'C:\\npm' }),
    existsSync: () => true,
    readFileSync: () => JSON.stringify({ version: '2.140.0' }),
    resolveCommand: () => 'C:\\npm\\codebuddy.cmd',
  });
  assert.deepEqual(result, { version: '2.140.0', installSource: 'npm_global', upgradeSupported: true, upgradeReason: null });
});

test('CodeBuddy 安装器固定官方包且拒绝任意版本字符串', () => {
  let invocation;
  const child = {};
  assert.equal(spawnCodeBuddyNpmInstall('2.140.0', {
    cwd: 'C:\\relay', env: {}, spawn: (command, args, options) => { invocation = { command, args, options }; return child; },
  }), child);
  assert.match(invocation.args.join(' '), /@tencent-ai\/codebuddy-code@2\.140\.0/);
  assert.throws(() => spawnCodeBuddyNpmInstall('../evil', { spawn: () => child }));
});

test('CodeBuddy 维护 readiness 使用唯一临时 workspace 并显式清理', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codebuddy-maintenance-'));
  const child = new EventEmitter();
  let invocation;
  try {
    const probe = createCodeBuddyReadinessProbe({
      root,
      env: {},
      execPath: 'node-test',
      spawn: (command, args, options) => {
        invocation = { command, args, options };
        return child;
      },
    });
    assert.equal(probe.child, child);

    const cwdIndex = invocation.args.indexOf('--cwd');
    const outputIndex = invocation.args.indexOf('--output');
    const modeIndex = invocation.args.indexOf('--mode');
    const probeCwd = invocation.args[cwdIndex + 1];
    const probeRoot = path.dirname(probeCwd);
    assert.equal(invocation.command, 'node-test');
    assert.equal(invocation.options.cwd, path.join(root, 'server'));
    assert.equal(path.basename(probeCwd), 'workspace');
    assert.notEqual(probeCwd, path.join(root, 'workspace'));
    assert.match(probeRoot, /engine-maintenance-readiness-/);
    assert.equal(path.dirname(invocation.args[outputIndex + 1]), probeRoot);
    assert.equal(invocation.args[modeIndex + 1], 'readiness');
    assert.equal(fs.existsSync(probeCwd), true);

    probe.cleanup();
    assert.equal(fs.existsSync(probeRoot), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CodeBuddy 轻量复验只运行 availability 模式', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codebuddy-availability-'));
  const child = new EventEmitter();
  let invocation;
  try {
    const probe = createCodeBuddyReadinessProbe({ root, mode: 'availability', spawn: (command, args) => { invocation = { command, args }; return child; } });
    assert.equal(invocation.args[invocation.args.indexOf('--mode') + 1], 'availability');
    probe.cleanup();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CodeBuddy 维护 readiness 在 spawn 同步失败时清理临时目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codebuddy-maintenance-error-'));
  try {
    assert.throws(() => createCodeBuddyReadinessProbe({
      root,
      spawn: () => { throw new Error('spawn failed'); },
    }), /spawn failed/);
    const probesRoot = path.join(root, '.relay-setup', 'probes');
    assert.deepEqual(fs.existsSync(probesRoot) ? fs.readdirSync(probesRoot) : [], []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CodeBuddy 维护 readiness 清理失败必须向调用方抛出', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codebuddy-maintenance-cleanup-error-'));
  const child = new EventEmitter();
  let probeRoot;
  try {
    const probe = createCodeBuddyReadinessProbe({
      root,
      fileSystem: {
        ...fs,
        rmSync: () => { throw new Error('locked forever'); },
      },
      spawn: (_command, args) => {
        probeRoot = path.dirname(args[args.indexOf('--cwd') + 1]);
        return child;
      },
    });
    assert.throws(() => probe.cleanup(), /清理 CodeBuddy readiness 临时目录失败：locked forever/);
    assert.equal(fs.existsSync(probeRoot), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('启动器通过隔离工厂运行 CodeBuddy readiness', () => {
  const source = fs.readFileSync(new URL('./start.mjs', import.meta.url), 'utf8');
  assert.match(source, /cleanupProcess: \(\) =>/);
  assert.match(source, /spawnCodeBuddyNpmInstall\(codeBuddyInstallVersion, \{ cwd: ROOT, stdio: 'pipe' \}\)/);
  assert.match(source, /createCodeBuddyReadinessProbe\(\{ root: ROOT, mode: codeBuddyReadinessMode, stdio: 'pipe' \}\)/);
  assert.match(source, /forwardMaintenanceOutput\('codebuddy-readiness', channel, chunk, context, false\)/);
  assert.doesNotMatch(source, /'--cwd', path\.join\(ROOT, 'workspace'\)/);
});
