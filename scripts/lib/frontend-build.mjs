import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runCommandSync } from './command.mjs';

export const FRONTEND_BUILD_SCHEMA_VERSION = 1;

const WINDOWS_RELEASE_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const WINDOWS_RELEASE_RETRY_DELAYS_MS = [60, 120, 240];

export function getFrontendBuildPaths(root) {
  const base = path.join(root, '.relay-build', 'frontend');
  return { base, staging: path.join(base, 'staging'), releases: path.join(base, 'releases'), state: path.join(base, 'state.json') };
}

function listFilesRecursive(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFilesRecursive(target) : entry.isFile() ? [target] : [];
  });
}

export function getFrontendFingerprintFiles(root) {
  const client = path.join(root, 'client');
  const candidates = [
    ...listFilesRecursive(path.join(client, 'src')),
    ...listFilesRecursive(path.join(client, 'public')),
    ...['index.html', 'vite.config.ts', 'vite-public-access.mjs', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json'].map((file) => path.join(client, file)),
    path.join(root, 'package.json'),
    path.join(client, 'scripts', 'check-build-budget.mjs'),
    path.join(root, 'scripts', 'lib', 'frontend-access.mjs'),
  ];
  return [...new Set(candidates.filter(fs.existsSync).map((file) => path.resolve(file)))].sort();
}

export function computeFrontendFingerprint(root) {
  const hash = crypto.createHash('sha256');
  for (const file of getFrontendFingerprintFiles(root)) {
    hash.update(path.relative(root, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function createEmptyFrontendBuildState() {
  return { schemaVersion: FRONTEND_BUILD_SCHEMA_VERSION, activeBuildId: null, previousBuildId: null, preparedBuildId: null, builds: {} };
}

export function readFrontendBuildState(statePath) {
  if (!fs.existsSync(statePath)) return createEmptyFrontendBuildState();
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed?.schemaVersion !== FRONTEND_BUILD_SCHEMA_VERSION || typeof parsed.builds !== 'object') return createEmptyFrontendBuildState();
    return { ...createEmptyFrontendBuildState(), ...parsed };
  } catch {
    return createEmptyFrontendBuildState();
  }
}

export function writeFrontendBuildState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, statePath);
}

export function formatFrontendBuildLabel(createdAt, buildId) {
  if (!Number.isFinite(createdAt) || typeof buildId !== 'string' || !/^[a-f0-9]{8,16}$/.test(buildId)) return null;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value) => String(value).padStart(2, '0');
  const timestamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${timestamp} · ${buildId.slice(0, 7)}`;
}

export function getFrontendBuildLabel(state, buildId) {
  return buildId ? formatFrontendBuildLabel(state?.builds?.[buildId]?.createdAt, buildId) : null;
}

function assertInside(base, target) {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === resolvedBase || !resolvedTarget.startsWith(`${resolvedBase}${path.sep}`)) throw new Error(`拒绝操作前端构建目录之外的路径：${resolvedTarget}`);
  return resolvedTarget;
}

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function promoteFrontendRelease({
  distPath,
  releasePath,
  rename = fs.renameSync,
  copy = fs.cpSync,
  remove = fs.rmSync,
  wait = waitSync,
} = {}) {
  if (!distPath || !releasePath) throw new Error('缺少前端构建发布路径');
  let renameError = null;
  for (let attempt = 0; attempt <= WINDOWS_RELEASE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      rename(distPath, releasePath);
      return { method: 'rename', retries: attempt };
    } catch (error) {
      renameError = error;
      if (!WINDOWS_RELEASE_RETRY_CODES.has(error?.code) || attempt === WINDOWS_RELEASE_RETRY_DELAYS_MS.length) break;
      wait(WINDOWS_RELEASE_RETRY_DELAYS_MS[attempt]);
    }
  }

  if (!WINDOWS_RELEASE_RETRY_CODES.has(renameError?.code)) throw renameError;
  try {
    copy(distPath, releasePath, { recursive: true, errorOnExist: true, force: false });
    assertCompleteFrontendRelease(releasePath);
    remove(distPath, { recursive: true, force: true });
    return { method: 'copy', retries: WINDOWS_RELEASE_RETRY_DELAYS_MS.length };
  } catch (copyError) {
    if (fs.existsSync(releasePath)) remove(releasePath, { recursive: true, force: true });
    throw new AggregateError([renameError, copyError], `前端 release 发布失败：${copyError.message}`);
  }
}

export function assertCompleteFrontendRelease(distPath) {
  if (!fs.existsSync(path.join(distPath, 'index.html'))
    || !fs.existsSync(path.join(distPath, 'assets'))
    || !fs.statSync(path.join(distPath, 'assets')).isDirectory()) {
    throw new Error('前端构建缺少 index.html 或 assets 目录');
  }
  const html = fs.readFileSync(path.join(distPath, 'index.html'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const reference = match[1];
    if (/^(?:https?:|data:|#)/.test(reference)) continue;
    const pathname = new URL(reference, 'http://relay.local').pathname;
    const target = path.resolve(distPath, pathname.replace(/^\//, ''));
    assertInside(distPath, target);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`前端构建引用缺失：${reference}`);
  }
}

export function isCompleteFrontendRelease(releasePath) {
  try {
    assertCompleteFrontendRelease(releasePath);
    return true;
  } catch {
    return false;
  }
}

function defaultRun(command, args, options) {
  const result = runCommandSync(command, args, { cwd: options.cwd, timeoutMs: options.timeoutMs });
  if (result.stdout) options.onOutput?.('stdout', result.stdout);
  if (result.stderr) options.onOutput?.('stderr', result.stderr);
  if (result.error || result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    const reason = result.error ? result.error.code || result.error.message : `退出码 ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} 执行失败（${reason}）${details ? `：\n${details}` : ''}`);
  }
}

export function prepareFrontendBuild({ root, run = defaultRun, now = Date.now, onProgress = () => {}, onOutput } = {}) {
  if (!root) throw new Error('缺少 Relay 根目录');
  onProgress('正在检查前端是否需要更新...');
  const paths = getFrontendBuildPaths(root);
  const fingerprint = computeFrontendFingerprint(root);
  const buildId = fingerprint.slice(0, 12);
  const releasePath = path.join(paths.releases, buildId);
  const state = readFrontendBuildState(paths.state);
  if (state.builds?.[buildId]?.fingerprint === fingerprint && isCompleteFrontendRelease(releasePath)) {
    const nextState = { ...state, preparedBuildId: buildId };
    writeFrontendBuildState(paths.state, nextState);
    return { buildId, buildLabel: getFrontendBuildLabel(nextState, buildId), fingerprint, releasePath, reused: true, state: nextState };
  }
  fs.mkdirSync(paths.staging, { recursive: true });
  fs.mkdirSync(paths.releases, { recursive: true });
  const stagingRoot = assertInside(paths.base, path.join(paths.staging, `${buildId}-${crypto.randomBytes(8).toString('hex')}`));
  const distPath = path.join(stagingRoot, 'dist');
  fs.mkdirSync(stagingRoot, { recursive: false });
  try {
    const clientDir = path.join(root, 'client');
    onProgress('正在检查前端代码...');
    run('npm', ['run', 'typecheck'], { cwd: clientDir, timeoutMs: 5 * 60_000, onOutput });
    onProgress('正在打包前端界面，请稍候...');
    run('npm', ['exec', '--', 'vite', 'build', '--outDir', distPath, '--emptyOutDir'], { cwd: clientDir, timeoutMs: 5 * 60_000, onOutput });
    onProgress('正在检查前端构建完整性和体积...');
    run('node', ['scripts/check-build-budget.mjs', distPath], { cwd: clientDir, timeoutMs: 60_000, captureOutput: true, onOutput });
    assertCompleteFrontendRelease(distPath);
    if (fs.existsSync(releasePath)) {
      if (!isCompleteFrontendRelease(releasePath)) fs.rmSync(assertInside(paths.releases, releasePath), { recursive: true, force: true });
      else throw new Error(`前端 release 已存在但状态不匹配：${buildId}`);
    }
    promoteFrontendRelease({ distPath, releasePath });
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    const nextState = { ...state, preparedBuildId: buildId, builds: { ...state.builds, [buildId]: { fingerprint, createdAt: now() } } };
    writeFrontendBuildState(paths.state, nextState);
    return { buildId, buildLabel: getFrontendBuildLabel(nextState, buildId), fingerprint, releasePath, reused: false, state: nextState };
  } catch (error) {
    if (fs.existsSync(stagingRoot)) fs.rmSync(assertInside(paths.staging, stagingRoot), { recursive: true, force: true });
    throw error;
  }
}

function parseWorkerResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const expected = ['channel', 'type', 'status', 'buildId', 'buildLabel', 'reused', 'message'];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) return null;
  if (value.channel !== 'relay-frontend-build-worker-v1' || value.type !== 'result') return null;
  if (!['completed', 'failed'].includes(value.status) || typeof value.reused !== 'boolean') return null;
  if (value.buildLabel !== null && (typeof value.buildLabel !== 'string' || value.buildLabel.length > 64 || /[\u0000-\u001f\u007f]/.test(value.buildLabel))) return null;
  if (value.message !== null && (typeof value.message !== 'string' || value.message.length > 8_000 || /[\u0000-\u001f\u007f]/.test(value.message))) return null;
  if (value.status === 'completed') {
    if (typeof value.buildId !== 'string' || !/^[a-f0-9]{12}$/.test(value.buildId) || value.message !== null) return null;
  } else if (value.buildId !== null || value.buildLabel !== null || value.reused !== false || typeof value.message !== 'string' || !value.message) return null;
  return value;
}

export function prepareFrontendBuildInWorker(options = {}) {
  const root = options.root;
  if (!root) return Promise.reject(new Error('缺少 Relay 根目录'));
  const workerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend-build-worker.mjs');
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = (options.spawnFn ?? spawn)(options.execPath ?? process.execPath, [workerPath], {
        cwd: root,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let result = null;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout?.on('data', (chunk) => { try { options.onStdout?.(chunk); } catch {} });
    child.stderr?.on('data', (chunk) => { try { options.onStderr?.(chunk); } catch {} });
    child.on?.('message', (message) => { result = parseWorkerResult(message); });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (!result) return finish(new Error('前端构建 worker 返回无效结果'));
      if (result.status === 'failed') return finish(new Error(result.message));
      if (code !== 0) return finish(new Error(`前端构建 worker ${signal ? `被信号 ${signal} 终止` : `退出码 ${code ?? '未知'}`}`));
      finish(null, { buildId: result.buildId, buildLabel: result.buildLabel, reused: result.reused });
    });
    const timer = setTimeout(() => {
      try { child.kill?.('SIGTERM'); } catch {}
      finish(new Error('前端构建 worker 执行超时'));
    }, options.timeoutMs ?? 11 * 60_000);
    timer.unref?.();
  });
}

export function verifyPreparedFrontendBuild(root, expectedBuildId) {
  if (typeof expectedBuildId !== 'string' || !/^[a-f0-9]{12}$/.test(expectedBuildId)) {
    throw new Error('预构建 Build ID 格式无效');
  }
  const paths = getFrontendBuildPaths(root);
  const state = readFrontendBuildState(paths.state);
  if (state.preparedBuildId !== expectedBuildId) throw new Error('前端预构建身份不一致');
  const releasePath = path.join(paths.releases, expectedBuildId);
  if (!isCompleteFrontendRelease(releasePath)) throw new Error('准备好的前端 release 不完整');
  return { buildId: expectedBuildId, releasePath, state };
}

export function resolveFrontendBuildForLaunch({ root, preparedBuildId = null, prepare = () => prepareFrontendBuild({ root }) }) {
  return preparedBuildId ? verifyPreparedFrontendBuild(root, preparedBuildId) : prepare();
}

export function activatePreparedFrontendBuild(root) {
  const paths = getFrontendBuildPaths(root);
  const state = readFrontendBuildState(paths.state);
  if (!state.preparedBuildId) throw new Error('没有可激活的前端构建');
  if (!isCompleteFrontendRelease(path.join(paths.releases, state.preparedBuildId))) throw new Error('准备好的前端 release 不完整');
  const nextState = { ...state, previousBuildId: state.activeBuildId === state.preparedBuildId ? state.previousBuildId : state.activeBuildId, activeBuildId: state.preparedBuildId, preparedBuildId: null };
  writeFrontendBuildState(paths.state, nextState);
  return nextState;
}

export function getFrontendBuildStatus(root) {
  const paths = getFrontendBuildPaths(root);
  const state = readFrontendBuildState(paths.state);
  const fingerprint = computeFrontendFingerprint(root);
  const expectedBuildId = fingerprint.slice(0, 12);
  const activeRelease = state.activeBuildId ? path.join(paths.releases, state.activeBuildId) : null;
  const fresh = state.activeBuildId === expectedBuildId && activeRelease && isCompleteFrontendRelease(activeRelease);
  return { ...state, activeBuildLabel: getFrontendBuildLabel(state, state.activeBuildId), fingerprint, expectedBuildId, fresh: Boolean(fresh), reason: fresh ? null : !state.activeBuildId ? '尚未激活生产构建' : state.activeBuildId !== expectedBuildId ? '前端源码较活动构建更新' : '活动构建不完整' };
}

export function cleanupOldFrontendReleases(root) {
  const paths = getFrontendBuildPaths(root);
  const state = readFrontendBuildState(paths.state);
  if (!fs.existsSync(paths.releases)) return [];
  const retained = new Set([state.activeBuildId, state.previousBuildId].filter(Boolean));
  const removed = [];
  for (const entry of fs.readdirSync(paths.releases, { withFileTypes: true })) {
    if (!entry.isDirectory() || retained.has(entry.name)) continue;
    fs.rmSync(assertInside(paths.releases, path.join(paths.releases, entry.name)), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}
