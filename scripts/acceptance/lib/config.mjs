import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, EXAMPLE_CONFIG_PATH, LOCAL_CONFIG_PATH, REPOSITORY_ROOT, SESSION_PATH } from './paths.mjs';
import { loadRelayConfig } from '../../lib/relay-config.mjs';

const CONFIG_KEYS = new Set([
  'origin',
  'username',
  'createdAt',
  'expiresAt',
  'edgePath',
  'desktopViewport',
  'mobileViewport',
  'timeouts',
]);
const VIEWPORT_KEYS = new Set(['width', 'height', 'deviceScaleFactor']);
const TIMEOUT_KEYS = new Set(['startupMs', 'navigationMs', 'scenarioMs']);
const RELAY_CONFIG = loadRelayConfig(path.join(REPOSITORY_ROOT, 'config', 'relay.conf'));

export function validateAcceptanceConfig(input, relayConfig = RELAY_CONFIG) {
  if (!isPlainObject(input)) throw new Error('验收配置必须是 JSON 对象');
  assertKnownKeys(input, CONFIG_KEYS, '配置');
  const allowedOrigins = new Set([
    relayConfig.frontend.origin,
  ]);
  if (['127.0.0.1', '::1'].includes(relayConfig.frontend.connectHost)) {
    allowedOrigins.add(`http://localhost:${relayConfig.frontend.port}`);
  }
  if (!allowedOrigins.has(input.origin)) throw new Error('配置 origin 必须是 Relay 配置的本机 production 地址');
  if (!isNonEmptyString(input.username, 64)) throw new Error('配置 username 无效');
  if (!isNonEmptyString(input.edgePath, 1024)) throw new Error('配置 edgePath 无效');
  validateOptionalTimestamp(input.createdAt, 'createdAt');
  validateOptionalTimestamp(input.expiresAt, 'expiresAt');
  validateViewport(input.desktopViewport, 'desktopViewport');
  validateViewport(input.mobileViewport, 'mobileViewport');
  validateTimeouts(input.timeouts);
  return structuredClone(input);
}

export function assertSafeConfigPath(targetPath, { inspectPath = inspectLocalPath } = {}) {
  const configRoot = path.resolve(CONFIG_DIR);
  const target = path.resolve(targetPath);
  if (target !== configRoot && path.dirname(target) !== configRoot) throw new Error('配置路径越界');

  const rootInfo = inspectPath(configRoot);
  if (!rootInfo.exists) throw new Error('配置目录不存在');
  if (rootInfo.isSymbolicLink || rootInfo.isReparsePoint) throw new Error('配置路径不得经过 reparse point');
  if (path.resolve(rootInfo.realPath) !== configRoot) throw new Error('配置目录真实路径越界');

  const targetInfo = inspectPath(target);
  if (targetInfo.exists && (targetInfo.isSymbolicLink || targetInfo.isReparsePoint)) {
    throw new Error('配置文件不得是 reparse point');
  }
}

export function loadAcceptanceConfig({
  configPath = LOCAL_CONFIG_PATH,
  assertPath = assertSafeConfigPath,
  isTracked = isGitTracked,
} = {}) {
  assertPath(configPath);
  if (isTracked(configPath) || (configPath === LOCAL_CONFIG_PATH && isTracked(SESSION_PATH))) {
    throw new Error('验收认证配置不得被 Git 跟踪');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('验收配置不存在，请先运行 acceptance:auth');
    throw new Error('验收配置 JSON 无效');
  }
  return validateAcceptanceConfig(parsed);
}

export function loadAcceptanceAuthConfig({
  configPath = LOCAL_CONFIG_PATH,
  templatePath = EXAMPLE_CONFIG_PATH,
  assertPath = assertSafeConfigPath,
  isTracked = isGitTracked,
  relayConfig = RELAY_CONFIG,
} = {}) {
  assertPath(configPath);
  assertPath(templatePath);
  if (isTracked(configPath) || (configPath === LOCAL_CONFIG_PATH && isTracked(SESSION_PATH))) {
    throw new Error('验收认证配置不得被 Git 跟踪');
  }
  const template = readConfigJson(templatePath, '验收配置模板 JSON 无效');
  const saved = fs.existsSync(configPath)
    ? readConfigJson(configPath, '验收配置 JSON 无效')
    : template;
  return prepareAcceptanceAuthConfig(saved, template, relayConfig);
}

export function prepareAcceptanceAuthConfig(saved, template, relayConfig = RELAY_CONFIG) {
  if (!isPlainObject(saved)) throw new Error('验收配置必须是 JSON 对象');
  assertKnownKeys(saved, CONFIG_KEYS, '配置');
  const migrated = { ...template, ...saved, origin: relayConfig.frontend.origin };
  delete migrated.createdAt;
  delete migrated.expiresAt;
  return validateAcceptanceConfig(migrated, relayConfig);
}

export function writeAcceptanceConfig(config, { configPath = LOCAL_CONFIG_PATH, assertPath = assertSafeConfigPath, isTracked = isGitTracked } = {}) {
  assertPath(configPath);
  if (isTracked(configPath) || (configPath === LOCAL_CONFIG_PATH && isTracked(SESSION_PATH))) {
    throw new Error('验收认证配置不得被 Git 跟踪');
  }
  writePrivateFile(configPath, `${JSON.stringify(validateAcceptanceConfig(config), null, 2)}\n`);
}

export function writePrivateFile(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function readConfigJson(filePath, errorMessage) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(errorMessage);
  }
}

export function isGitTracked(filePath, { runGit = spawnSync } = {}) {
  const result = runGit('git', ['ls-files', '--error-unmatch', '--', path.relative(REPOSITORY_ROOT, filePath)], {
    cwd: REPOSITORY_ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result?.error || result?.signal || !Number.isInteger(result?.status)) {
    throw new Error('无法确认 Git 跟踪状态');
  }
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error('无法确认 Git 跟踪状态');
}

function inspectLocalPath(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, isSymbolicLink: false, isReparsePoint: false, realPath: filePath };
  const stat = fs.lstatSync(filePath);
  const isSymbolicLink = stat.isSymbolicLink();
  const isReparsePoint = isSymbolicLink || hasWindowsReparsePoint(filePath);
  return {
    exists: true,
    isSymbolicLink,
    isReparsePoint,
    realPath: fs.realpathSync.native(filePath),
  };
}

function hasWindowsReparsePoint(filePath) {
  if (process.platform !== 'win32') return false;
  try {
    const output = execFileSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "if ((Get-Item -Force -LiteralPath $env:RELAY_ACCEPTANCE_INSPECT_PATH).Attributes -band [IO.FileAttributes]::ReparsePoint) { '1' } else { '0' }",
    ], {
      encoding: 'utf8',
      env: { ...process.env, RELAY_ACCEPTANCE_INSPECT_PATH: filePath },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return output.trim() === '1';
  } catch {
    throw new Error('无法验证配置路径的 reparse point 属性');
  }
}

function validateViewport(value, label) {
  if (!isPlainObject(value)) throw new Error(`配置 ${label} 无效`);
  assertKnownKeys(value, VIEWPORT_KEYS, label);
  if (!isIntegerInRange(value.width, 240, 7680)
    || !isIntegerInRange(value.height, 240, 4320)
    || typeof value.deviceScaleFactor !== 'number'
    || !Number.isFinite(value.deviceScaleFactor)
    || value.deviceScaleFactor < 0.5
    || value.deviceScaleFactor > 4) {
    throw new Error(`配置 ${label} 无效`);
  }
}

function validateTimeouts(value) {
  if (!isPlainObject(value)) throw new Error('配置 timeouts 无效');
  assertKnownKeys(value, TIMEOUT_KEYS, 'timeouts');
  for (const key of TIMEOUT_KEYS) {
    if (!isIntegerInRange(value[key], 1000, 600000)) throw new Error(`配置 timeouts.${key} 无效`);
  }
}

function validateOptionalTimestamp(value, label) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`配置 ${label} 无效`);
  }
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label}包含未知配置项`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isNonEmptyString(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength && !/[\r\n\0]/u.test(value);
}

function isIntegerInRange(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}
