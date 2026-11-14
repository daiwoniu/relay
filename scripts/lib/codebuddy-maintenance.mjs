import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { buildCommandInvocation, resolveCommand, runCommandSync } from './command.mjs';

export const CODEBUDDY_PACKAGE = '@tencent-ai/codebuddy-code';
export const CODEBUDDY_QUOTA_EXIT_CODE = 42;

function isCodeBuddyQuotaExceeded(promptResult) {
  const metadata = promptResult?._meta;
  const rawError = metadata?.['codebuddy.ai/errorMessage'];
  let providerError;
  if (typeof rawError === 'string') {
    try { providerError = JSON.parse(rawError); } catch {}
  }
  return providerError?.data?.category === 'quota' && providerError.data.statusCode === 429;
}

function codeBuddyProbeFailureMessage(promptResult) {
  if (isCodeBuddyQuotaExceeded(promptResult)) return 'CodeBuddy 模型额度已用尽（HTTP 429）；请在 CodeBuddy 处理额度后重试';
  const stopReason = typeof promptResult?.stopReason === 'string' ? promptResult.stopReason : 'unknown';
  if (stopReason === 'refusal') return 'CodeBuddy 模型请求被拒绝（stopReason=refusal）';
  return `CodeBuddy readiness 未收到 session/request_permission（stopReason=${stopReason}）`;
}

function codeBuddyProbeFailure(promptResult) {
  const error = new Error(codeBuddyProbeFailureMessage(promptResult));
  if (isCodeBuddyQuotaExceeded(promptResult)) error.code = 'CODEBUDDY_QUOTA_EXHAUSTED';
  return error;
}

export function codeBuddyProbeExitCode(error) {
  return error?.code === 'CODEBUDDY_QUOTA_EXHAUSTED' ? CODEBUDDY_QUOTA_EXIT_CODE : 1;
}

export function assertCodeBuddyPromptCompleted(promptResult) {
  if (promptResult?.stopReason === 'end_turn' && promptResult?._meta?.['codebuddy.ai/outcome'] !== 'FAILED_MODEL_REQUEST') return;
  throw codeBuddyProbeFailure(promptResult);
}

export function createCodeBuddySetupState(status, readinessOk, readinessFailure = null, checkedAt = new Date().toISOString()) {
  const installed = Boolean(status.version);
  const quotaDeferred = installed && readinessFailure === 'provider_quota';
  return {
    ideInstalled: false,
    cliInstalled: installed,
    authReady: installed && (readinessOk || quotaDeferred),
    acpSupported: installed,
    protocolReady: installed && (readinessOk || quotaDeferred),
    available: installed && readinessOk,
    version: status.version,
    installSource: status.installSource,
    readinessCheckedAt: installed && readinessOk ? checkedAt : null,
    readinessFailure: quotaDeferred ? 'provider_quota' : null,
  };
}

export function classifyCodeBuddyPermissionProbe(permissionRequested, promptResult) {
  if (promptResult?.stopReason === 'refusal') throw codeBuddyProbeFailure(promptResult);
  if (permissionRequested) return 'requested';
  throw codeBuddyProbeFailure(promptResult);
}

export function assertCodeBuddyCancellationResult(promptResult) {
  if (promptResult?.stopReason === 'cancelled') return;
  if (isCodeBuddyQuotaExceeded(promptResult) || promptResult?.stopReason === 'refusal') {
    throw codeBuddyProbeFailure(promptResult);
  }
  throw new Error(`CodeBuddy readiness 未确认取消（stopReason=${promptResult?.stopReason || 'unknown'}）`);
}

function normalize(filePath, platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const value = api.resolve(filePath).replaceAll('\\', '/');
  return platform === 'win32' ? value.toLowerCase() : value;
}

export function inspectCodeBuddyInstallation(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const run = options.runCommandSync || runCommandSync;
  const exists = options.existsSync || fs.existsSync;
  const read = options.readFileSync || fs.readFileSync;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const rootResult = run('npm', ['root', '-g'], { env, timeoutMs: 5_000 });
  const prefixResult = run('npm', ['prefix', '-g'], { env, timeoutMs: 5_000 });
  if (rootResult.status !== 0 || prefixResult.status !== 0) {
    return { version: null, installSource: 'unknown', upgradeSupported: false, upgradeReason: '无法确认 CodeBuddy npm 全局安装' };
  }
  const npmRoot = String(rootResult.stdout || '').trim();
  const npmPrefix = String(prefixResult.stdout || '').trim();
  const packageFile = api.join(npmRoot, '@tencent-ai', 'codebuddy-code', 'package.json');
  if (!npmRoot || !npmPrefix || !exists(packageFile)) {
    return { version: null, installSource: 'unknown', upgradeSupported: false, upgradeReason: '当前 CodeBuddy 不是受支持的 npm 全局安装' };
  }
  let version = null;
  try { version = JSON.parse(read(packageFile, 'utf8')).version || null; } catch {}
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    return { version: null, installSource: 'unknown', upgradeSupported: false, upgradeReason: 'CodeBuddy npm 安装信息损坏或不可读' };
  }
  const resolved = (options.resolveCommand || resolveCommand)('codebuddy', { env, platform });
  const expected = platform === 'win32'
    ? [api.join(npmPrefix, 'codebuddy.cmd'), api.join(npmPrefix, 'codebuddy.exe')]
    : [api.join(npmPrefix, 'bin', 'codebuddy')];
  if (!expected.some((candidate) => normalize(candidate, platform) === normalize(resolved, platform))) {
    return { version, installSource: 'unknown', upgradeSupported: false, upgradeReason: 'CodeBuddy 命令与 npm 全局包不一致，已阻止页面升级' };
  }
  return { version, installSource: 'npm_global', upgradeSupported: true, upgradeReason: null };
}

export function createCodeBuddyInstallationCache(options = {}) {
  const inspect = options.inspect || (() => inspectCodeBuddyInstallation(options));
  let current = inspect();
  return { get: () => current, refresh: () => (current = inspect()) };
}

export function spawnCodeBuddyNpmInstall(version = 'latest', options = {}) {
  if (version !== 'latest' && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('无效的 CodeBuddy 回退版本');
  const invocation = buildCommandInvocation('npm', ['install', '-g', `${CODEBUDDY_PACKAGE}@${version}`], { env: options.env || process.env });
  return (options.spawn || spawn)(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: options.stdio || 'inherit',
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

export function createCodeBuddyReadinessProbe(options = {}) {
  const root = options.root;
  if (!root) throw new Error('缺少 Relay 根目录');
  const fileSystem = options.fileSystem || fs;
  const probesRoot = path.join(root, '.relay-setup', 'probes');
  fileSystem.mkdirSync(probesRoot, { recursive: true });
  const probeRoot = fileSystem.mkdtempSync(path.join(probesRoot, 'engine-maintenance-readiness-'));
  const probeCwd = path.join(probeRoot, 'workspace');
  const output = path.join(probeRoot, 'readiness.jsonl');
  fileSystem.mkdirSync(probeCwd, { recursive: true });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    try {
      fileSystem.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      cleaned = true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`清理 CodeBuddy readiness 临时目录失败：${detail}`, { cause: error });
    }
  };

  try {
    const mode = options.mode || 'readiness';
    if (mode !== 'readiness' && mode !== 'availability') throw new Error('CodeBuddy readiness 探针模式无效');
    const child = (options.spawn || spawn)(options.execPath || process.execPath, [
      '--import', 'tsx', path.join(root, 'server', 'scripts', 'probe-codebuddy-acp.ts'),
      '--cwd', probeCwd,
      '--output', output,
      '--mode', mode,
      '--timeout-ms', '60000',
    ], {
      cwd: path.join(root, 'server'),
      env: options.env || process.env,
      stdio: options.stdio || 'inherit',
      windowsHide: true,
    });
    return { child, cleanup };
  } catch (error) {
    try { cleanup(); } catch (cleanupError) {
      try { (options.onCleanupError || console.error)(cleanupError.message); } catch {}
    }
    throw error;
  }
}
