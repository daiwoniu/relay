import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertSafeConfigPath,
  isGitTracked,
  loadAcceptanceAuthConfig,
  loadAcceptanceConfig,
  prepareAcceptanceAuthConfig,
  validateAcceptanceConfig,
  writePrivateFile,
} from './lib/config.mjs';
import {
  CONFIG_DIR,
  LOCAL_CONFIG_PATH,
  SESSION_PATH,
  resolveConfigPath,
} from './lib/paths.mjs';

const validConfig = {
  origin: 'http://localhost:19083',
  username: 'admin',
  createdAt: '2026-08-14T06:00:00.000Z',
  expiresAt: '2026-09-13T06:00:00.000Z',
  edgePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  desktopViewport: { width: 1456, height: 819, deviceScaleFactor: 1 },
  mobileViewport: { width: 390, height: 844, deviceScaleFactor: 1 },
  timeouts: { startupMs: 15000, navigationMs: 30000, scenarioMs: 120000 },
};
const relayConfig = {
  frontend: { origin: 'http://127.0.0.1:19083', connectHost: '127.0.0.1', port: 19083 },
};
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_TEMP_ROOT = path.join(REPO_ROOT, '.relay-dev', 'test-tmp');

test('配置路径固定在平台config/acceptance目录，不依赖ai目录', () => {
  assert.equal(CONFIG_DIR, path.join(REPO_ROOT, 'config', 'acceptance'));
  assert.equal(resolveConfigPath('local.json'), LOCAL_CONFIG_PATH);
  assert.equal(resolveConfigPath('session.dpapi'), SESSION_PATH);
  assert.equal(path.dirname(LOCAL_CONFIG_PATH), CONFIG_DIR);
  assert.throws(() => resolveConfigPath('../outside.json'), /配置文件名无效/);
  assert.throws(() => resolveConfigPath('nested/local.json'), /配置文件名无效/);
});

test('拒绝符号链接、junction、reparse point 和真实路径越界', () => {
  const safe = (overrides = {}) => ({ exists: true, isSymbolicLink: false, isReparsePoint: false, realPath: CONFIG_DIR, ...overrides });
  assert.throws(() => assertSafeConfigPath(LOCAL_CONFIG_PATH, { inspectPath: () => safe({ isSymbolicLink: true }) }), /reparse point/);
  assert.throws(() => assertSafeConfigPath(LOCAL_CONFIG_PATH, { inspectPath: () => safe({ isReparsePoint: true }) }), /reparse point/);
  assert.throws(() => assertSafeConfigPath(LOCAL_CONFIG_PATH, { inspectPath: () => safe({ realPath: path.dirname(CONFIG_DIR) }) }), /越界/);
});

test('配置使用严格 schema 并只接受本机 production origin', () => {
  const configured = { ...validConfig, origin: 'http://localhost:19083' };
  assert.deepEqual(validateAcceptanceConfig(configured, relayConfig), configured);
  assert.equal(validateAcceptanceConfig({ ...configured, origin: 'http://127.0.0.1:19083' }, relayConfig).origin, 'http://127.0.0.1:19083');
  for (const origin of ['https://example.com', 'http://localhost:19082', 'http://192.168.1.2:19083', 'http://localhost:19083/path']) {
    assert.throws(() => validateAcceptanceConfig({ ...configured, origin }, relayConfig), /origin/);
  }
  assert.throws(() => validateAcceptanceConfig({ ...validConfig, password: 'secret' }, relayConfig), /未知配置项/);
  assert.throws(() => validateAcceptanceConfig({ ...validConfig, desktopViewport: { width: 0, height: 819, deviceScaleFactor: 1 } }, relayConfig), /desktopViewport/);
});

test('认证入口迁移旧 production 地址并丢弃旧认证时间', () => {
  const template = {
    ...validConfig,
    origin: 'http://localhost:19083',
  };
  delete template.createdAt;
  delete template.expiresAt;
  const saved = {
    ...validConfig,
    origin: 'http://localhost:19082',
    username: 'saved-admin',
    createdAt: '2026-8-15 上午 09:23:41',
    expiresAt: '2026-9-14 上午 09:23:39',
  };

  const migratedRelayConfig = {
    frontend: { origin: 'http://127.0.0.1:19084', connectHost: '127.0.0.1', port: 19084 },
  };
  const migrated = prepareAcceptanceAuthConfig(saved, template, migratedRelayConfig);

  assert.equal(migrated.origin, 'http://127.0.0.1:19084');
  assert.equal(migrated.username, 'saved-admin');
  assert.equal('createdAt' in migrated, false);
  assert.equal('expiresAt' in migrated, false);
  assert.throws(
    () => prepareAcceptanceAuthConfig({ ...saved, password: 'secret' }, template, migratedRelayConfig),
    /未知配置项/,
  );
});

test('认证加载器可从旧配置文件恢复到当前模板地址', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-acceptance-auth-migration-'));
  try {
    const configPath = path.join(root, 'local.json');
    const templatePath = path.join(root, 'config.example.json');
    fs.writeFileSync(configPath, JSON.stringify({
      ...validConfig,
      origin: 'http://localhost:19082',
      createdAt: '2026-8-15 上午 09:23:41',
      expiresAt: '2026-9-14 上午 09:23:39',
    }));
    fs.writeFileSync(templatePath, JSON.stringify({
      ...validConfig,
      origin: 'http://localhost:19083',
      createdAt: undefined,
      expiresAt: undefined,
    }));

    const migrated = loadAcceptanceAuthConfig({
      configPath,
      templatePath,
      assertPath: () => {},
      isTracked: () => false,
      relayConfig: {
        frontend: { origin: 'http://127.0.0.1:19084', connectHost: '127.0.0.1', port: 19084 },
      },
    });

    assert.equal(migrated.origin, 'http://127.0.0.1:19084');
    assert.equal('createdAt' in migrated, false);
    assert.equal('expiresAt' in migrated, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('读取配置前拒绝被 Git 跟踪的敏感文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-acceptance-config-'));
  try {
    const configPath = path.join(root, 'local.json');
    fs.writeFileSync(configPath, JSON.stringify(validConfig));
    assert.throws(() => loadAcceptanceConfig({
      configPath,
      assertPath: () => {},
      isTracked: () => true,
    }), /不得被 Git 跟踪/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('配置错误不会泄露 Cookie 内容', () => {
  const secret = 'relay_session=VERY_SECRET_COOKIE';
  let message = '';
  try {
    validateAcceptanceConfig({ ...validConfig, unexpected: secret });
  } catch (error) {
    message = error.message;
  }
  assert.doesNotMatch(message, /VERY_SECRET_COOKIE/);
});

test('私有文件写入可安全覆盖且不遗留临时文件', () => {
  fs.mkdirSync(TEST_TEMP_ROOT, { recursive: true });
  assert.equal(
    path.relative(fs.realpathSync(REPO_ROOT), fs.realpathSync(TEST_TEMP_ROOT)),
    path.join('.relay-dev', 'test-tmp'),
  );
  const root = fs.mkdtempSync(path.join(TEST_TEMP_ROOT, 'relay-acceptance-private-'));
  assert.equal(
    path.relative(fs.realpathSync(REPO_ROOT), fs.realpathSync(root)),
    path.join('.relay-dev', 'test-tmp', path.basename(root)),
  );
  try {
    const target = path.join(root, 'session.dpapi');
    writePrivateFile(target, 'first');
    writePrivateFile(target, 'second');
    assert.equal(fs.readFileSync(target, 'utf8'), 'second');
    assert.deepEqual(fs.readdirSync(root), ['session.dpapi']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Git 跟踪检查仅将明确未跟踪视为安全，其余错误失败关闭', () => {
  const target = path.join(CONFIG_DIR, 'session.dpapi');
  assert.equal(isGitTracked(target, { runGit: () => ({ status: 0 }) }), true);
  assert.equal(isGitTracked(target, { runGit: () => ({ status: 1 }) }), false);
  assert.throws(() => isGitTracked(target, { runGit: () => ({ status: 128 }) }), /无法确认 Git 跟踪状态/);
  assert.throws(() => isGitTracked(target, { runGit: () => ({ status: null, error: new Error('spawn failed') }) }), /无法确认 Git 跟踪状态/);
});
