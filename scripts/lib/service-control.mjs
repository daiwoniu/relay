import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';

const DEFAULT_STOP_TIMEOUT_MS = 10_000;

function createPortMap(ports) {
  return new Map(ports.map((port) => [port, []]));
}

function addPid(result, port, pid) {
  if (!result.has(port) || !Number.isInteger(pid) || pid <= 0) return;
  const pids = result.get(port);
  if (!pids.includes(pid)) pids.push(pid);
}

function parseEndpointPort(endpoint) {
  const match = /:(\d+)$/.exec(String(endpoint || ''));
  return match ? Number.parseInt(match[1], 10) : null;
}

export function parseWindowsNetstat(output, ports) {
  const result = createPortMap(ports);
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const fields = rawLine.trim().split(/\s+/);
    if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP') continue;
    const port = parseEndpointPort(fields[1]);
    const state = fields.at(-2).toUpperCase();
    const pid = Number.parseInt(fields.at(-1), 10);
    if (!['LISTENING', 'LISTEN'].includes(state)) continue;
    addPid(result, port, pid);
  }
  return result;
}

export function parseSsListeningPids(output, ports) {
  const result = createPortMap(ports);
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    if (!/^LISTEN\s/i.test(rawLine.trim())) continue;
    const portMatches = [...rawLine.matchAll(/:(\d+)(?:\s|$)/g)];
    const pidMatches = [...rawLine.matchAll(/pid=(\d+)/g)];
    for (const portMatch of portMatches) {
      const port = Number.parseInt(portMatch[1], 10);
      for (const pidMatch of pidMatches) addPid(result, port, Number.parseInt(pidMatch[1], 10));
    }
  }
  return result;
}

export function findListeningPids(ports, options = {}) {
  const platform = options.platform || process.platform;
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  if (platform === 'win32') {
    const result = spawnSyncFn('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error('无法读取 Windows TCP 监听进程');
    return parseWindowsNetstat(result.stdout, ports);
  }

  const byPort = createPortMap(ports);
  let lsofAvailable = true;
  for (const port of ports) {
    const result = spawnSyncFn('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: 'pipe' });
    if (result.error?.code === 'ENOENT') {
      lsofAvailable = false;
      break;
    }
    if (result.error || ![0, 1].includes(result.status)) throw new Error(`无法读取端口 ${port} 的监听进程`);
    for (const value of String(result.stdout || '').split(/\s+/)) addPid(byPort, port, Number.parseInt(value, 10));
  }
  if (lsofAvailable) return byPort;

  const ss = spawnSyncFn('ss', ['-ltnp'], { encoding: 'utf8', stdio: 'pipe' });
  if (ss.error || ss.status !== 0) throw new Error('当前系统缺少可用的 lsof 或 ss，无法定位监听进程');
  return parseSsListeningPids(ss.stdout, ports);
}

export function pidExists(pid, killFn = process.kill.bind(process)) {
  try {
    killFn(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves absence. Permission or inspection failures must not
    // allow a listener to be bypassed as an exited process.
    return error?.code !== 'ESRCH';
  }
}

export function isCodexGhostListener(service, pids, options = {}) {
  return (options.platform ?? process.platform) === 'win32' && service.id === 'codex'
    && pids.length > 0 && pids.every((pid) => !(options.pidExistsFn ?? pidExists)(pid));
}

export function isCodexListenerPid(pid, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') return false;
  const result = (options.spawnSyncFn ?? spawnSync)('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 5000,
  });
  return !result.error && result.status === 0 && String(result.stdout).split(/\r?\n/)
    .some(line => new RegExp(`^"codex\\.exe","${pid}"`, 'i').test(line.trim()));
}

/** The npm wrapper may already be gone while its native app-server still owns the port. */
export async function stopRemainingCodexListeners(port, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') return;
  const pids = (options.findListeningPidsFn ?? findListeningPids)([port]).get(port) ?? [];
  for (const pid of pids) {
    if (!(options.isCodexListenerPidFn ?? isCodexListenerPid)(pid, options)) continue;
    await (options.stopPidTreeByPidFn ?? stopPidTreeByPid)(pid, options);
  }
}

export async function stopPidTreeByPid(pid, options = {}) {
  const platform = options.platform || process.platform;
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const killFn = options.killFn || process.kill.bind(process);
  if (!pidExists(pid, killFn)) return;
  if (platform === 'win32') {
    // Kill the tree while its parent is still alive. Killing only the parent first loses descendants.
    const result = options.spawnSyncFn
      ? spawnSyncFn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          encoding: 'utf8',
          stdio: 'pipe',
          windowsHide: true,
        })
      : await runTaskkill(pid, options.spawnFn || spawn);
    if ((result.error || result.status !== 0) && pidExists(pid, killFn)) {
      throw new Error(`停止进程树失败（PID ${pid}${result.status === null ? '' : `，taskkill 退出码 ${result.status}`}）`);
    }
    return;
  }

  try {
    killFn(pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
    return;
  }
  const deadline = Date.now() + (options.graceTimeoutMs ?? 3000);
  while (Date.now() < deadline && pidExists(pid, killFn)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (pidExists(pid, killFn)) {
    try { killFn(pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  }
}

function runTaskkill(pid, spawnFn) {
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
    }, 5000);
    child.once('error', (error) => {
      finish({ error, status: null });
    });
    child.once('exit', (status) => {
      finish({ error: null, status });
    });
  });
}

export async function waitForPortsReleased(ports, options = {}) {
  const findPids = options.findListeningPidsFn || ((targetPorts) => findListeningPids(targetPorts, options));
  const processExists = options.pidExistsFn || pidExists;
  const reported = new Set();
  const remainingPids = (current, port) => {
    const pids = current.get(port) || [];
    if ((options.platform ?? process.platform) === 'win32' && options.allowGhostPorts?.includes(port)
      && pids.length > 0 && pids.every(pid => !processExists(pid))) {
      if (!reported.has(port)) { reported.add(port); options.onGhostListener?.(port, pids); }
      return [];
    }
    return pids;
  };
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const current = findPids(ports);
    if (ports.every((port) => remainingPids(current, port).length === 0)) return;
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 200));
  }
  const current = findPids(ports);
  const remaining = ports.filter((port) => remainingPids(current, port).length > 0);
  if (remaining.length === 0) return;
  let ghostListenerDetected = false;
  const details = remaining.map((port) => {
    const pids = current.get(port) || [];
    const missingPids = pids.filter((pid) => !processExists(pid));
    if (missingPids.length > 0) ghostListenerDetected = true;
    const missingText = missingPids.length > 0 ? `；PID ${missingPids.join('、')} 已不存在` : '';
    return `${port}（PID ${pids.join('、')}${missingText}）`;
  });
  const remediation = ghostListenerDetected
    ? '；检测到疑似 Windows 幽灵监听，普通停止命令无法清理；Codex 可在下次启动时切换空闲端口，其他服务请检查残留句柄或改用空闲端口'
    : '';
  throw new Error(`等待端口释放超时：${details.join('、')}${remediation}`);
}

export async function stopServicesByPorts(services, options = {}) {
  const write = options.write || console.log;
  const ports = services.map((service) => service.port);
  const findPids = options.findListeningPidsFn || ((targetPorts) => findListeningPids(targetPorts, options));
  const stopPid = options.stopPidTreeByPidFn || ((pid) => stopPidTreeByPid(pid, options));
  const byPort = findPids(ports);
  const releaseOptions = { ...options, allowGhostPorts: services.filter(service => service.id === 'codex').map(service => service.port),
    onGhostListener: (port) => write(`Codex 端口 ${port} 仍有已退出 PID 的残留监听；未强杀其他进程，下次启动将自动选择空闲端口。`) };
  const stoppedPids = new Set();
  let foundAny = false;
  let failed = false;

  write('=== Relay 停止 ===');
  write('');
  for (let index = services.length - 1; index >= 0; index -= 1) {
    const service = services[index];
    const pids = byPort.get(service.port) || [];
    if (pids.length === 0) {
      write(`[${services.length - index}/${services.length}] ${service.name}：未运行`);
      continue;
    }
    foundAny = true;
    if (isCodexGhostListener(service, pids, options)) {
      write(`${service.name}：原进程已退出，端口残留将在下次启动时绕过。`);
      continue;
    }
    write(`[${services.length - index}/${services.length}] ${service.name}：正在停止（PID ${pids.join('、')}）`);
    for (const pid of pids) {
      if (stoppedPids.has(pid)) continue;
      stoppedPids.add(pid);
      try {
        await stopPid(pid);
      } catch (error) {
        failed = true;
        write(`  停止失败：${error.message}`);
      }
    }
  }
  write('');

  if (failed) {
    write('');
    return 1;
  }
  if (foundAny) {
    try {
      await waitForPortsReleased(ports, { ...releaseOptions, findListeningPidsFn: findPids });
    } catch (error) {
      write(`停止失败：${error.message}`);
      write('');
      return 1;
    }
    write('停止完成，受管服务均已退出');
  } else {
    write('未检测到正在运行的服务，无需停止。');
  }
  write('');
  return 0;
}
