import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadWorkspaceConfig, readWorkspaceSettings, requireWorkspaceFile, requireWorkspaceRoot } from './workspace-config.js';
import { getServiceErrorResponse } from '../services/errors.js';

test('workbench config resolves an explicit local root without assuming a developer directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-workspace-config-'));
  try {
    const file = path.join(dir, 'nested', 'config.conf');
    assert.deepEqual(loadWorkspaceConfig(file), { workspaceRoot: '', configured: false });
    const initialized = fs.readFileSync(file, 'utf8');
    assert.match(initialized, /^# /);
    assert.match(initialized, /^workspace_root=$/m);
    assert.match(initialized, /保存后重启后端/);
    const missing = readWorkspaceSettings(file);
    assert.deepEqual(missing, { workspaceRoot: '', configured: false, error: null });
    assert.throws(() => requireWorkspaceRoot(undefined, missing), /workspace-console\.local\.conf.*workspace_root/);
    try { requireWorkspaceRoot(undefined, missing); }
    catch (error) {
      const response = getServiceErrorResponse(error);
      assert.equal(response.status, 422);
      assert.equal(response.code, 'WORKSPACE_CONFIG_REQUIRED');
      assert.match(response.message, /workspace-console\.local\.conf/);
    }
    for (const text of ['', '# optional root\n', 'workspace_root=\n']) {
      fs.writeFileSync(file, text);
      assert.deepEqual(loadWorkspaceConfig(file), { workspaceRoot: '', configured: false });
    }
    fs.writeFileSync(file, `workspace_root=${dir}`);
    assert.deepEqual(loadWorkspaceConfig(file), { workspaceRoot: path.normalize(dir), configured: true });
    fs.writeFileSync(file, `\uFEFF# local settings\r\n\r\n workspace_root = ${dir}${path.sep} \r\n`);
    assert.deepEqual(loadWorkspaceConfig(file), { workspaceRoot: path.resolve(dir), configured: true });
    assert.equal(requireWorkspaceFile(dir, 'nested', 'config.conf'), file);
    assert.throws(() => requireWorkspaceRoot(path.join(dir, 'missing-root')), /根目录不存在/);
    assert.throws(() => requireWorkspaceFile(dir, 'missing.py'), /缺少必要文件：missing.py/);
    const special = path.join(dir, 'space = hash#目录');
    fs.writeFileSync(file, `workspace_root=${special}`);
    assert.equal(loadWorkspaceConfig(file).workspaceRoot, special);
    assert.equal(fs.readFileSync(file, 'utf8'), `workspace_root=${special}`);
    for (const text of ['bad line', 'workspace_root=./relative', `workspace_root=${dir}\0`,
      `workspace_root=${dir}\ntask_id=demo`, `workspace_root=${dir}\nworkspace_root=${dir}`]) {
      fs.writeFileSync(file, text);
      assert.throws(() => loadWorkspaceConfig(file), /工作台本机配置/);
      const invalid = readWorkspaceSettings(file);
      assert.equal(invalid.configured, false);
      assert.match(invalid.error!, /工作台本机配置/);
      assert.throws(() => requireWorkspaceRoot(undefined, invalid), /工作台本机配置/);
      assert.equal(fs.readFileSync(file, 'utf8'), text);
    }
    // A file where the parent directory should be simulates initialization
    // failure without depending on OS permissions or running as an admin.
    const blockedParent = path.join(dir, 'blocked');
    fs.writeFileSync(blockedParent, 'preserve');
    const blocked = readWorkspaceSettings(path.join(blockedParent, 'config.conf'));
    assert.equal(blocked.configured, false);
    assert.match(blocked.error!, /无法读取|无法初始化/);
    assert.equal(fs.readFileSync(blockedParent, 'utf8'), 'preserve');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
