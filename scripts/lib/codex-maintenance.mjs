import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { buildCommandInvocation, resolveCommand, runCommand, runCommandSync } from './command.mjs';

const VERSION_PATTERN = /(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

function parseVersion(output) {
  return VERSION_PATTERN.exec(String(output || '').trim())?.[1] || null;
}

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function resolveCodexCommand(env, platform, exists) {
  if (platform === 'win32') return resolveCommand('codex', { env, platform });
  const platformPath = pathApi(platform);
  const pathEntries = String(env.PATH || '').split(platformPath.delimiter).filter(Boolean);
  return pathEntries.map((directory) => platformPath.join(directory, 'codex')).find((candidate) => exists(candidate)) || 'codex';
}

function normalize(filePath, platform) {
  const value = pathApi(platform).resolve(filePath).replaceAll('\\', '/');
  return platform === 'win32' ? value.toLowerCase() : value;
}

export function inspectCodexInstallation(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const run = options.runCommandSync || runCommandSync;
  const resolve = options.resolveCommand || resolveCommand;
  const exists = options.existsSync || fs.existsSync;
  const read = options.readFileSync || fs.readFileSync;
  const platformPath = pathApi(platform);
  const versionResult = run('codex', ['--version'], { env, timeoutMs: 5_000 });
  const version = versionResult.status === 0 ? parseVersion(versionResult.stdout) : null;
  if (!version) {
    return {
      version: null,
      installSource: 'unknown',
      upgradeSupported: false,
      upgradeReason: '无法读取当前 Codex 版本',
    };
  }

  const npmRootResult = run('npm', ['root', '-g'], { env, timeoutMs: 5_000 });
  if (npmRootResult.status !== 0) {
    return { version, installSource: 'unknown', upgradeSupported: false, upgradeReason: '无法确认 Codex 的 npm 安装来源' };
  }
  const npmRoot = String(npmRootResult.stdout || '').trim();
  const npmPrefixResult = run('npm', ['prefix', '-g'], { env, timeoutMs: 5_000 });
  if (npmPrefixResult.status !== 0) {
    return { version, installSource: 'unknown', upgradeSupported: false, upgradeReason: '无法确认 Codex 的 npm 全局命令目录' };
  }
  const npmPrefix = String(npmPrefixResult.stdout || '').trim();
  const packageFile = platformPath.join(npmRoot, '@openai', 'codex', 'package.json');
  if (!npmRoot || !npmPrefix || !exists(packageFile)) {
    return { version, installSource: 'unknown', upgradeSupported: false, upgradeReason: '当前 Codex 不是受支持的 npm 全局安装' };
  }

  let packageVersion = null;
  try {
    packageVersion = JSON.parse(read(packageFile, 'utf8')).version || null;
  } catch {
    return { version, installSource: 'unknown', upgradeSupported: false, upgradeReason: 'Codex npm 安装信息损坏或不可读' };
  }
  const resolvedCodex = options.resolveCommand
    ? resolve('codex', { env, platform })
    : resolveCodexCommand(env, platform, exists);
  const expectedCommands = platform === 'win32'
    ? [platformPath.join(npmPrefix, 'codex.cmd'), platformPath.join(npmPrefix, 'codex.exe')]
    : [platformPath.join(npmPrefix, 'bin', 'codex')];
  const commandMatches = expectedCommands.some((candidate) => normalize(candidate, platform) === normalize(resolvedCodex, platform));
  if (!commandMatches || packageVersion !== version) {
    return { version, installSource: 'unknown', upgradeSupported: false, upgradeReason: 'Codex 命令与 npm 全局包不一致，已阻止页面升级' };
  }
  return { version, installSource: 'npm_global', upgradeSupported: true, upgradeReason: null };
}

export function createCodexInstallationCache(options = {}) {
  const inspect = options.inspect || (() => inspectCodexInstallation(options));
  let current = inspect();
  return {
    get: () => current,
    refresh: () => {
      current = inspect();
      return current;
    },
  };
}

export async function inspectCodexSandboxHealth(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return { ok: true, skipped: true, reason: null };

  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const run = options.runCommand || runCommand;
  const now = options.now || Date.now;
  const startedAt = now();
  const doctor = await run('codex', ['doctor', '--json', '--summary'], { env, cwd, timeoutMs: 30_000 });
  // Do not copy raw doctor output/errors: they can contain auth and provider data.
  const code = ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'E2BIG', 'ENOMEM', 'ENOBUFS', 'ETIMEDOUT', 'ABORT_ERR'].includes(doctor.error?.code)
    ? doctor.error.code : doctor.error ? 'UNCLASSIFIED' : 'none';
  const summary = `exit=${Number.isInteger(doctor.status) ? doctor.status : 'unknown'}, durationMs=${Math.max(0, now() - startedAt)}, stdoutBytes=${Buffer.byteLength(String(doctor.stdout || ''))}, stderrBytes=${Buffer.byteLength(String(doctor.stderr || ''))}, error=${code}`;
  const failed = (reason) => ({ ok: false, skipped: false, reason: `${reason}（${summary}）` });
  if (doctor.timedOut) return failed('Codex doctor 执行超时，无法验证 Windows sandbox');
  if (doctor.error || doctor.signal) return failed('Codex doctor 执行失败，无法验证 Windows sandbox');
  if (!String(doctor.stdout || '').trim()) return failed(doctor.status === 0
    ? 'Codex doctor 输出为空，无法验证 Windows sandbox'
    : 'Codex doctor 执行失败且无 JSON 输出，无法验证 Windows sandbox');
  let report;
  try {
    report = JSON.parse(String(doctor.stdout || ''));
  } catch {
    return failed('Codex doctor JSON 无法解析，无法验证 Windows sandbox');
  }
  const sandboxChecks = Object.values(report?.checks || {}).filter((check) => check?.category === 'sandbox');
  if (sandboxChecks.length === 0) {
    return failed('Codex doctor 未返回 sandbox 诊断，无法确认升级后环境');
  }
  const unhealthy = sandboxChecks.find((check) => check.status !== 'ok');
  if (unhealthy) {
    return failed('Codex doctor 未确认 Windows sandbox 诊断全部正常');
  }

  const roots = [cwd, ...(options.workspaceRoots || [])].filter((value, index, values) => {
    if (typeof value !== 'string') return false;
    const normalized = path.win32.resolve(value).toLowerCase();
    return values.findIndex((candidate) => typeof candidate === 'string' && path.win32.resolve(candidate).toLowerCase() === normalized) === index;
  });
  for (const workspaceRoot of roots) {
    const canary = await run('codex', [
      'sandbox', '--permission-profile', ':workspace', '--cd', workspaceRoot,
      'powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive',
      '-Command', 'Get-Location | Out-Null',
    ], { env, cwd: workspaceRoot, timeoutMs: 15_000 });
    if (canary.status !== 0) {
      return { ok: false, skipped: false, reason: 'Codex Windows sandbox 无法启动最小命令（受控工作区）' };
    }
  }
  return { ok: true, skipped: false, reason: null };
}

export function spawnCodexNpmUpgrade(version = 'latest', options = {}) {
  if (version !== 'latest' && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('无效的 Codex 回退版本');
  const env = options.env || process.env;
  const spawnFn = options.spawn || spawn;
  const invocation = buildCommandInvocation('npm', ['install', '-g', `@openai/codex@${version}`], { env });
  return spawnFn(invocation.command, invocation.args, {
    cwd: options.cwd,
    env,
    stdio: options.stdio || 'inherit',
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

export function runCodexNpmUpgrade(options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCodexNpmUpgrade('latest', options);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Codex npm 升级失败（${signal ? `信号 ${signal}` : `退出码 ${code ?? '未知'}`}）`));
    });
  });
}
