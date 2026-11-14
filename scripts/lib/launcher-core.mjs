import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { buildCommandInvocation } from './command.mjs';
import { pidExists } from './service-control.mjs';

export const OWNERSHIP_NOTICE = '按 Ctrl+C 停止本次启动器拉起的服务。';
export const LOGS_NOTICE = '详细日志：logs/';
const MAX_CAPTURED_OUTPUT = 64 * 1024;

export function orderOwnedServicesForStop(entries) {
  const priority = { codex: 0, frontend: 1, backend: 2 };
  return [...entries].sort((left, right) =>
    (priority[left.service.id] ?? 3) - (priority[right.service.id] ?? 3));
}

export function getOrSpawnOwnedService(service, owned, spawnChild, onChildCreated, now = Date.now) {
  const existing = owned.get(service.id);
  if (existing) return { child: existing.child, reused: true };
  const child = spawnChild(service);
  owned.set(service.id, { service, child, startedAt: now() });
  onChildCreated(service, child);
  return { child, reused: false };
}

export function createLauncherOutputWriter({ writeEvent, write = console.log, writeError = console.error } = {}) {
  const record = (message) => {
    const text = String(message ?? '');
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) writeEvent?.(line);
    }
  };
  return {
    write(...args) { record(args[0]); write(...args); },
    writeError(...args) { record(args[0]); writeError(...args); },
  };
}

export function loadDotEnv(filePath, environ = process.env) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const separator = line.indexOf('=');
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && ['"', "'"].includes(value[0])) value = value.slice(1, -1);
    if (name && environ[name] === undefined) environ[name] = value;
  }
}

export function validateRuntimePrerequisites(requiredPaths) {
  const missing = requiredPaths.filter((filePath) => !fs.existsSync(filePath));
  if (missing.length > 0) throw new Error('Relay 尚未完成初始化，请先运行 npm run setup');
}

export async function httpReady(url, timeoutMs = 2000) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Relay-Launcher/2.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function checkServices(services, ready = httpReady, write = console.log) {
  const missing = [];
  write('=== Relay 健康检查 ===');
  write('');
  for (let index = 0; index < services.length; index += 1) {
    const service = services[index];
    const healthy = await ready(service.healthUrl);
    write(`[${index + 1}/${services.length}] ${service.name}: ${healthy ? '就绪' : '未运行'} | 地址: ${service.displayUrl}`);
    if (!healthy) missing.push(service.name);
  }
  write('');
  if (missing.length > 0) {
    write(`检查完成，未运行：${missing.join('、')}`);
    write('');
    return 1;
  }
  write('检查完成，全部服务均已就绪');
  write('');
  return 0;
}

export async function reportExistingServices(services, ready = httpReady, write = console.log, listeningPids = new Map(), pidExistsFn = pidExists) {
  const statuses = [];
  for (const service of services) {
    const pids = listeningPids.get(service.port) || [];
    statuses.push({ service, running: await ready(service.healthUrl), pids, missingPids: pids.filter((pid) => !pidExistsFn(pid)) });
  }
  if (!statuses.some((entry) => entry.running || entry.pids.length > 0)) return null;

  write('=== 启动前服务检查 ===');
  write('');
  for (let index = 0; index < statuses.length; index += 1) {
    const { service, running, pids, missingPids } = statuses[index];
    let statusText = '未运行';
    if (running) statusText = `启动前已在运行${pids.length > 0 ? `（PID ${pids.join('、')}）` : ''}`;
    else if (pids.length > 0 && missingPids.length > 0) {
      statusText = `端口 ${service.port} 被异常占用且服务未就绪（PID ${pids.join('、')}；已不存在：${missingPids.join('、')}，疑似 Windows 幽灵监听）`;
    } else if (pids.length > 0) statusText = `端口 ${service.port} 已被占用但服务未就绪（PID ${pids.join('、')}）`;
    write(`[${index + 1}/${statuses.length}] ${service.name}：${statusText} | 地址：${service.displayUrl}`);
  }
  write('');
  if (statuses.some((entry) => entry.missingPids.length > 0)) {
    write('检测到 Windows 幽灵监听。Codex 将在下次启动时自动选择空闲端口；其他服务请检查残留句柄或改用空闲端口。');
  } else if (statuses.some((entry) => !entry.running && entry.pids.length > 0)) {
    write('检测到未就绪的端口占用，本次未启动任何服务。');
    write('停止服务：npm run stop');
  } else {
    write('以上服务在本命令执行前已经运行，本次未启动任何服务。');
    write('停止服务：npm run stop');
    write('重新启动：npm run restart');
  }
  write('');
  return statuses.every((entry) => entry.running) ? 0 : 1;
}

export function getLanAccessUrls(port = 9081, interfaces = os.networkInterfaces()) {
  const results = [];
  const seen = new Set();
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const entry of addresses || []) {
      const isIPv4 = entry.family === 'IPv4' || entry.family === 4;
      if (!isIPv4 || entry.internal || !isPrivateIPv4(entry.address) || seen.has(entry.address)) continue;
      seen.add(entry.address);
      results.push({ name, address: entry.address, url: `http://${entry.address}:${port}` });
    }
  }
  return results;
}

/** Start a low-frequency watcher that reports LAN address changes. */
export function watchLanAccessUrls({ port = 9081, intervalMs = 5 * 60 * 1000, getInterfaces = () => os.networkInterfaces(), write = console.log, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  let previous = getLanAccessUrls(port, getInterfaces());
  const signature = (entries) => entries.map(({ name, address, url }) => `${name}|${address}|${url}`).join('\n');
  let previousSignature = signature(previous);
  const timer = setIntervalFn(() => {
    const current = getLanAccessUrls(port, getInterfaces());
    const currentSignature = signature(current);
    if (currentSignature === previousSignature) return;
    const oldByAddress = new Map(previous.map((entry) => [entry.name, entry.url]));
    const newByAddress = new Map(current.map((entry) => [entry.name, entry.url]));
    write('\n[网络变化] 局域网访问地址已更新：');
    for (const [name, url] of oldByAddress) if (newByAddress.get(name) !== url) write(`  ${name}: ${url} -> ${newByAddress.get(name) || '已移除'}`);
    for (const [name, url] of newByAddress) if (!oldByAddress.has(name)) write(`  ${name}: ${url}`);
    previous = current;
    previousSignature = currentSignature;
  }, intervalMs);
  return () => clearIntervalFn(timer);
}

function isPrivateIPv4(address) {
  return /^10\./.test(address)
    || /^192\.168\./.test(address)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

export function spawnService(service, options = {}) {
  const spawnFn = options.spawnFn || spawn;
  const invocation = buildCommandInvocation(service.command, service.args);
  const onOutput = typeof options.onOutput === 'function' ? options.onOutput : null;
  const stdio = service.ipc
    ? ['ignore', 'pipe', 'pipe', 'ipc']
    : ['ignore', 'pipe', 'pipe'];
  const child = spawnFn(invocation.command, invocation.args, {
    cwd: service.cwd,
    env: { ...(options.env || process.env), ...(service.env || {}) },
    stdio,
    detached: process.platform !== 'win32',
    windowsHide: process.platform === 'win32',
    shell: invocation.shell,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  child.terminateTreeFirst = service.terminateTreeFirst === true;
  let captured = '';
  const append = (channel, chunk) => {
    captured = `${captured}${chunk.toString()}`.slice(-MAX_CAPTURED_OUTPUT);
    onOutput?.(service, channel, chunk);
  };
  child.stdout?.on('data', (chunk) => append('stdout', chunk));
  child.stderr?.on('data', (chunk) => append('stderr', chunk));
  child.getCapturedOutput = () => captured.trim();
  return child;
}

export function getCapturedOutput(child) {
  return typeof child?.getCapturedOutput === 'function' ? child.getCapturedOutput() : '';
}

export function captureCtrlC(input, onInterrupt) {
  if (!input?.isTTY || typeof input.setRawMode !== 'function') return () => {};

  const wasRaw = input.isRaw === true;
  const wasPaused = typeof input.isPaused === 'function' ? input.isPaused() : false;
  const handleData = (chunk) => {
    if (Buffer.from(chunk).includes(3)) onInterrupt();
  };

  try {
    input.setRawMode(true);
    input.resume?.();
    input.on('data', handleData);
  } catch {
    return () => {};
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    input.removeListener?.('data', handleData);
    try {
      input.setRawMode(wasRaw);
    } catch {
      // 终端可能已经关闭，无需继续恢复。
    }
    if (wasPaused) input.pause?.();
  };
}

export async function stopProcessTree(child, options = {}) {
  const platform = options.platform || process.platform;
  const killFn = options.killFn || process.kill.bind(process);
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (platform === 'win32') {
    if (options.terminateTreeFirst ?? child.terminateTreeFirst) {
      const runTaskkillFn = options.runTaskkillFn || ((pid) => runTaskkill(pid, options.spawnFn || spawn, options.taskkillTimeoutMs ?? 5000));
      const result = await runTaskkillFn(child.pid);
      if (result.error || result.status !== 0) {
        try {
          await waitForChildExit(child, options.retryTimeoutMs ?? 500);
          return; // It may have exited between the state check and taskkill. The caller still verifies the port.
        } catch {
          throw new Error(`停止进程树失败（PID ${child.pid}，taskkill 退出码 ${result.status ?? '未知'}）`);
        }
      }
      await waitForChildExit(child, options.exitTimeoutMs || 5000);
      return;
    }
    let terminationSent = false;
    try {
      killFn(child.pid, 'SIGTERM');
      terminationSent = true;
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      // 权限不足或当前运行时无法发送信号时，直接回退 taskkill。
    }
    if (terminationSent) {
      try {
        await waitForChildExit(child, options.graceTimeoutMs ?? 800);
        return;
      } catch {
        // 子服务未在终止信号的宽限时间内退出，继续强制清理进程树。
      }
    }
    const runTaskkillFn = options.runTaskkillFn || ((pid) => runTaskkill(pid, options.spawnFn || spawn, options.taskkillTimeoutMs ?? 5000));
    const result = await runTaskkillFn(child.pid);
    if (result.error) {
      throw new Error(`停止进程树失败（PID ${child.pid}）：无法执行 taskkill`);
    }
    if (result.status !== 0) {
      try {
        await waitForChildExit(child, options.retryTimeoutMs ?? 500);
        return;
      } catch {
        throw new Error(`停止进程树失败（PID ${child.pid}，taskkill 退出码 ${result.status}）`);
      }
    }
    await waitForChildExit(child, options.exitTimeoutMs || 5000);
    return;
  }
  try {
    killFn(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    return;
  }
  try {
    await waitForChildExit(child, options.exitTimeoutMs || 5000);
  } catch {
    try { killFn(-child.pid, 'SIGKILL'); } catch {}
    await waitForChildExit(child, options.exitTimeoutMs || 5000);
  }
}

function runTaskkill(pid, spawnFn, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let settled = false;
    child.stdout?.resume();
    child.stderr?.resume();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill?.();
      finish({ error: Object.assign(new Error(`taskkill 超时（PID ${pid}）`), { code: 'ETIMEDOUT' }), status: null });
    }, timeoutMs);
    child.once('error', (error) => finish({ error, status: null }));
    child.once('exit', (status) => finish({ error: null, status }));
  });
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (typeof child.once !== 'function') throw new Error(`无法确认进程已退出（PID ${child.pid}）`);
  await new Promise((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.removeListener?.('exit', onExit);
      reject(new Error(`等待进程退出超时（PID ${child.pid}）`));
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

export async function waitForReady(service, child, ready = httpReady, timeoutMs = service.startupTimeoutMs ?? 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready(service.healthUrl)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${service.name} 启动失败，进程退出码 ${child.exitCode ?? child.signalCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${service.name} 启动超时（${Math.round(timeoutMs / 1000)} 秒）`);
}
