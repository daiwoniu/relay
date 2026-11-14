import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { REPOSITORY_ROOT } from './paths.mjs';

export const ACCEPTANCE_ROOT = path.join(REPOSITORY_ROOT, '.relay-dev', 'acceptance');
const RUN_ID_PATTERN = /^run-[a-f0-9]{16,64}$/u;
const STATE_KEYS = new Set(['runId', 'pid', 'profileDir', 'port', 'webSocketUrl', 'status', 'startedAt', 'updatedAt', 'cleanup']);
const RUN_STATUSES = new Set(['starting', 'running', 'startup_failed', 'cleaned', 'cleanup_incomplete']);

export function createRunId() { return `run-${randomBytes(16).toString('hex')}`; }
export function assertRunId(runId) { if (!RUN_ID_PATTERN.test(String(runId))) throw new Error('run ID 无效'); return runId; }
export function createRunPaths(runId = createRunId()) {
  assertRunId(runId);
  const runDir = path.join(ACCEPTANCE_ROOT, runId);
  return { runId, runDir, profileDir: path.join(runDir, 'profile'), statePath: path.join(runDir, 'state.json') };
}
export function assertSafeCleanupTarget(value) {
  const raw = String(value || '');
  const runId = path.basename(raw);
  assertRunId(runId);
  const expected = path.join(ACCEPTANCE_ROOT, runId);
  if (!path.isAbsolute(raw) && raw !== runId) throw new Error('清理目标必须是明确 run ID');
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : expected;
  if (resolved !== expected) throw new Error('清理目标越界');
  return expected;
}
export function selectOwnedProcesses(processes, profileDir) {
  const profile = path.resolve(profileDir);
  if (!profile.startsWith(`${path.resolve(ACCEPTANCE_ROOT)}${path.sep}`) || path.basename(profile) !== 'profile') throw new Error('profile 路径无效');
  const needle = path.normalize(profile).toLowerCase();
  const argumentsToMatch = [`--user-data-dir=${needle}`, `--user-data-dir="${needle}"`];
  return processes.filter((item) => {
    const commandLine = path.normalize(String(item.commandLine || '')).toLowerCase();
    return Number.isInteger(item.pid)
      && String(item.name || '').toLowerCase() === 'msedge.exe'
      && argumentsToMatch.some((argument) => commandLine.includes(argument));
  }).map((item) => item.pid);
}
export function writeRunState(statePath, state, { assertStatePath = assertSafeStatePath } = {}) {
  assertStatePath(statePath);
  const safeState = Object.fromEntries([...STATE_KEYS].filter((key) => state[key] !== undefined).map((key) => [key, state[key]]));
  const tempPath = `${statePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(tempPath, `${JSON.stringify(safeState, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try { fs.renameSync(tempPath, statePath); } finally { fs.rmSync(tempPath, { force: true }); }
  return safeState;
}
export function finalizeRunState(runtime, cleanup, {
  writeState = writeRunState,
  now = () => new Date(),
} = {}) {
  const statePath = runtime.statePath || path.join(path.dirname(runtime.profileDir), 'state.json');
  const cleaned = cleanup.process === 'cleaned'
    && cleanup.port === 'released'
    && cleanup.profile === 'removed';
  return writeState(statePath, {
    ...runtime,
    status: cleaned ? 'cleaned' : 'cleanup_incomplete',
    updatedAt: now().toISOString(),
    cleanup,
  });
}
export function readRunState(runIdOrDir) {
  const runDir = assertSafeCleanupTarget(runIdOrDir);
  assertRuntimePaths(runDir);
  const statePath = path.join(runDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return validateRunState(state, runDir);
}
export function validateRunState(state, runDir) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('运行状态无效');
  const unknown = Object.keys(state).filter((key) => !STATE_KEYS.has(key));
  if (unknown.length > 0) throw new Error('运行状态包含未知字段');
  const expectedRunId = path.basename(runDir);
  const expectedProfile = path.join(runDir, 'profile');
  if (state.runId !== expectedRunId || path.resolve(state.profileDir || '') !== path.resolve(expectedProfile)) throw new Error('运行状态路径不一致');
  if (state.pid !== undefined && (!Number.isInteger(state.pid) || state.pid < 1)) throw new Error('运行状态 PID 无效');
  if (!RUN_STATUSES.has(state.status)) throw new Error('运行状态值无效');
  validateStateTimestamp(state.startedAt, 'startedAt');
  if (state.updatedAt !== undefined) validateStateTimestamp(state.updatedAt, 'updatedAt');
  if (state.port !== undefined && (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535)) throw new Error('运行状态端口无效');
  if (state.webSocketUrl !== undefined) validateStateWebSocket(state.webSocketUrl, state.port);
  if (state.status === 'running' && (state.port === undefined || state.webSocketUrl === undefined)) throw new Error('运行中状态缺少 CDP 信息');
  if (state.cleanup !== undefined) validateCleanupResult(state.cleanup);
  return state;
}
export function assertRuntimePaths(runDir) {
  const expected = assertSafeCleanupTarget(runDir);
  for (const target of [expected, path.join(expected, 'state.json'), path.join(expected, 'profile')]) {
    if (!fs.existsSync(target)) continue;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error('运行路径不得是 reparse point');
    const real = path.normalize(fs.realpathSync.native(target)).toLowerCase();
    const lexical = path.normalize(path.resolve(target)).toLowerCase();
    if (real !== lexical) throw new Error('运行路径真实位置越界');
  }
  return expected;
}
export function listRunStates() {
  if (!fs.existsSync(ACCEPTANCE_ROOT)) return [];
  return fs.readdirSync(ACCEPTANCE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
    .map((entry) => {
      try { return readRunState(entry.name); } catch { return { runId: entry.name, status: 'invalid' }; }
    });
}
function assertSafeStatePath(statePath) {
  const resolved = path.resolve(statePath);
  const runDir = path.dirname(resolved);
  assertSafeCleanupTarget(runDir);
  if (path.basename(resolved) !== 'state.json') throw new Error('运行状态路径无效');
}
function validateStateTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`运行状态 ${label} 无效`);
}
function validateStateWebSocket(value, port) {
  let url;
  try { url = new URL(value); } catch { throw new Error('运行状态 WebSocket 地址无效'); }
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port
    || url.username || url.password || url.search || url.hash
    || !/^\/devtools\/browser\/[A-Za-z0-9._-]+$/u.test(url.pathname)) {
    throw new Error('运行状态 WebSocket 地址无效');
  }
}
function validateCleanupResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'port,process,profile'
    || !['cleaned', 'remaining'].includes(value.process)
    || !['released', 'listening'].includes(value.port)
    || !['removed', 'remaining'].includes(value.profile)) {
    throw new Error('运行状态 cleanup 无效');
  }
}
