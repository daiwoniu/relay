import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertRuntimePaths, createRunId, createRunPaths, writeRunState } from './run-state.mjs';
import { queryOwnedProcesses, terminateOwnedProcesses } from './process-control.mjs';
export { createRunId, createRunPaths } from './run-state.mjs';

export function buildEdgeArguments({ profileDir }) {
  return ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--no-first-run', '--disable-extensions', '--disable-background-networking', 'about:blank'];
}
export function buildEdgeSpawnOptions() {
  return { windowsHide: true, shell: false, detached: false, stdio: 'ignore' };
}
export async function launchEdge({ edgePath, origin, timeoutMs = 15000, spawnImpl = spawn }) {
  const paths = createRunPaths();
  fs.mkdirSync(paths.profileDir, { recursive: true });
  assertRuntimePaths(paths.runDir);
  const child = spawnImpl(edgePath, buildEdgeArguments({ profileDir: paths.profileDir }), buildEdgeSpawnOptions());
  const startedAt = new Date().toISOString();
  writeRunState(paths.statePath, { runId: paths.runId, pid: child.pid, profileDir: paths.profileDir, status: 'starting', startedAt });
  const portFile = path.join(paths.profileDir, 'DevToolsActivePort');
  try {
    const { port, webSocketPath } = await Promise.race([
      waitForDevToolsPort(portFile, timeoutMs),
      new Promise((_, reject) => child.once('error', () => reject(new Error('Edge 启动失败')))),
    ]);
    const runtime = { ...paths, child, pid: child.pid, port, webSocketUrl: `ws://127.0.0.1:${port}${webSocketPath}`, startedAt };
    writeRunState(paths.statePath, { runId: paths.runId, pid: child.pid, profileDir: paths.profileDir, port, webSocketUrl: runtime.webSocketUrl, status: 'running', startedAt });
    return runtime;
  } catch (error) {
    child.kill();
    await terminateOwnedProcesses(paths.profileDir).catch(() => []);
    writeRunState(paths.statePath, { runId: paths.runId, pid: child.pid, profileDir: paths.profileDir, status: 'startup_failed', startedAt, updatedAt: new Date().toISOString() });
    throw error;
  }
}
export async function waitForDevToolsPort(filePath, timeoutMs, now = Date.now) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (fs.existsSync(filePath)) {
      try { return parseDevToolsActivePort(fs.readFileSync(filePath, 'utf8')); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等待 Edge 调试端口超时');
}
export function parseDevToolsActivePort(content) {
  const lines = String(content).trim().split(/\r?\n/u);
  const port = Number(lines[0]);
  const webSocketPath = lines[1];
  if (lines.length !== 2 || !Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9._-]+$/u.test(webSocketPath || '')) {
    throw new Error('DevToolsActivePort 内容无效');
  }
  return { port, webSocketPath };
}
export async function cleanupEdgeRuntime({ runtime, cdp, waitForExit = waitForProcessExit, terminateOwned = () => terminateOwnedProcesses(runtime.profileDir), queryOwned = () => queryOwnedProcesses(runtime.profileDir), checkPortReleased = () => runtime.port ? waitForPortReleased(runtime.port) : Promise.resolve(true), removeProfile = async () => { fs.rmSync(runtime.profileDir, { recursive: true, force: true }); return !fs.existsSync(runtime.profileDir); } }) {
  await cdp?.closeBrowser?.().catch(() => {});
  const exited = await waitForExit(runtime.child, 3000);
  if (!exited) await terminateOwned();
  const remaining = await queryOwned();
  const portReleased = await checkPortReleased();
  const profileRemoved = portReleased && remaining.length === 0 ? await removeProfile() : false;
  return { process: remaining.length === 0 ? 'cleaned' : 'remaining', port: portReleased ? 'released' : 'listening', profile: profileRemoved ? 'removed' : 'remaining' };
}
export function waitForProcessExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, timeoutMs);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    child.once('exit', onExit);
  });
}
export function isPortReleased(port, { connect = net.connect } = {}) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
  });
}
export async function waitForPortReleased(port, { timeoutMs = 3000, check = isPortReleased } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await check(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return false;
}
