import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';

export function resolveCommand(command, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (platform !== 'win32' || path.isAbsolute(command) || /[\\/]/.test(command)) return command;

  const pathEntries = String(env.PATH || '').split(path.delimiter).map((entry) => entry.replace(/^"|"$/g, '')).filter(Boolean);
  const extensions = path.extname(command)
    ? ['']
    : String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension.toLowerCase()}`);
      if (fs.existsSync(candidate)) return candidate;
      const upperCandidate = path.join(directory, `${command}${extension.toUpperCase()}`);
      if (fs.existsSync(upperCandidate)) return upperCandidate;
    }
  }
  return command;
}

export function buildCommandInvocation(command, args, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const nodeExecutable = options.nodeExecutable || process.execPath;
  const resolved = resolveCommand(command, { platform, env });
  if (platform === 'win32' && ['.cmd', '.bat'].includes(path.extname(resolved).toLowerCase())) {
    const shimDirectory = path.dirname(resolved);
    const nodeCliCandidates = command === 'npm'
      ? [env.npm_execpath, path.join(shimDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      : command === 'codex'
          ? [path.join(shimDirectory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]
          : command === 'codebuddy'
            ? [path.join(shimDirectory, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy')]
            : [];
    const nodeCli = nodeCliCandidates.find((candidate) => candidate && fs.existsSync(candidate));
    if (nodeCli) {
      return { command: nodeExecutable, args: [nodeCli, ...args], shell: false, windowsVerbatimArguments: false };
    }
    throw new Error(`无法安全执行 Windows 命令包装：${resolved}`);
  }
  return { command: resolved, args, shell: false, windowsVerbatimArguments: false };
}

export function runCommandSync(command, args, options = {}) {
  try {
    const invocation = buildCommandInvocation(command, args, options);
    const spawnSyncFn = options.spawnSyncFn || spawnSync;
    return spawnSyncFn(invocation.command, invocation.args, {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: options.inherit ? 'inherit' : 'pipe',
      env: options.env || process.env,
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      timeout: options.timeoutMs,
      killSignal: 'SIGTERM',
    });
  } catch (error) {
    return { error, status: null, stdout: '', stderr: '' };
  }
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const invocation = buildCommandInvocation(command, args, options);
      const spawnFn = options.spawnFn || spawn;
      child = spawnFn(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: options.env || process.env,
        stdio: 'pipe',
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
    } catch (error) {
      resolve({ error, status: null, stdout: '', stderr: '' });
      return;
    }

    const maxOutputBytes = options.maxOutputBytes || 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const append = (current, chunk) => `${current}${String(chunk)}`.slice(0, maxOutputBytes);
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs) : null;
    timer?.unref?.();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    child.once('error', (error) => finish({ error, status: null }));
    child.once('close', (status, signal) => finish({
      status,
      signal,
      ...(timedOut ? { timedOut: true, error: new Error(`命令执行超时（${options.timeoutMs}ms）`) } : {}),
    }));
  });
}
