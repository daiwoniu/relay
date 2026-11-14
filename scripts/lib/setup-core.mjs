import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CHINA_REGISTRY = 'https://mirrors.cloud.tencent.com/npm/';
export const SETUP_SCHEMA_VERSION = 1;

const CHINA_REGISTRY_HOSTS = new Set([
  'mirrors.cloud.tencent.com',
  'registry.npmmirror.com',
  'npmmirror.com',
  'registry.npm.taobao.org',
]);

export function parseNodeMajor(version) {
  const match = /^v?(\d+)/.exec(String(version).trim());
  return match ? Number.parseInt(match[1], 10) : Number.NaN;
}

export function normalizeRegistry(registry) {
  const value = String(registry || '').trim();
  if (!value) return '';
  return value.endsWith('/') ? value : `${value}/`;
}

export function validateRegistryUrl(registry) {
  const url = new URL(String(registry || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('npm registry 只支持 http 或 https 协议');
  }
  return normalizeRegistry(url.toString());
}

export function isChinaRegistry(registry) {
  try {
    return CHINA_REGISTRY_HOSTS.has(new URL(normalizeRegistry(registry)).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function hashFiles(files, extraValues = []) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.basename(file));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  for (const value of extraValues) {
    hash.update(String(value));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const DEPENDENCY_MANIFEST_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'overrides',
  'resolutions',
  'engines',
  'os',
  'cpu',
  'libc',
  'packageManager',
  'workspaces',
];

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])]));
}

export function hashDependencyManifests(files, extraValues = []) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const basename = path.basename(file);
    hash.update(basename);
    hash.update('\0');
    if (basename === 'package.json') {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      const dependencyManifest = Object.fromEntries(DEPENDENCY_MANIFEST_FIELDS
        .filter((field) => manifest[field] !== undefined)
        .map((field) => [field, sortJsonValue(manifest[field])]));
      hash.update(JSON.stringify(dependencyManifest));
    } else {
      hash.update(fs.readFileSync(file));
    }
    hash.update('\0');
  }
  for (const value of extraValues) {
    hash.update(String(value));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function dependenciesNeedInstall({ force, savedFingerprint, currentFingerprint, compatibleFingerprints = [], nodeModulesPath, criticalPaths }) {
  if (force) return { needed: true, reason: '用户要求强制重新安装' };
  if (!fs.existsSync(nodeModulesPath)) return { needed: true, reason: 'node_modules 不存在' };
  if (!savedFingerprint) return { needed: true, reason: '没有成功初始化记录' };
  if (savedFingerprint !== currentFingerprint && !compatibleFingerprints.includes(savedFingerprint)) {
    return { needed: true, reason: '依赖清单发生变化' };
  }
  const missing = criticalPaths.find((candidate) => !fs.existsSync(candidate));
  if (missing) return { needed: true, reason: `关键依赖缺失：${path.basename(missing)}` };
  return { needed: false, reason: '依赖已安装且未发生变化' };
}

export function readSetupState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return parsed?.schemaVersion === SETUP_SCHEMA_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSetupState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify({ schemaVersion: SETUP_SCHEMA_VERSION, ...state }, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, statePath);
}

export function parseSetupArguments(argv) {
  const result = { force: false, checkOnly: false, help: false, registry: null, managedRecovery: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--force') result.force = true;
    else if (argument === '--check-only') result.checkOnly = true;
    else if (argument === '--managed-recovery') result.managedRecovery = true;
    else if (argument === 'help' || argument === '--help') result.help = true;
    else if (argument === '--registry') {
      result.registry = argv[index + 1] || '';
      index += 1;
    } else if (argument.startsWith('--registry=')) {
      result.registry = argument.slice('--registry='.length);
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return result;
}
