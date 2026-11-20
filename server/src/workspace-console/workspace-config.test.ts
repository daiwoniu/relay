import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadWorkspaceConfig, readWorkspaceSettings, requireWorkspaceFile, requireWorkspaceRoot } from './workspace-config.js';

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-workbench-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, base: path.join(root, 'workbench.conf'), local: path.join(root, 'workbench.local.conf'), legacy: path.join(root, 'workspace-console.local.conf') };
}
test('base/local overlay keeps stable ID and explicit clearing; optional config never writes on read', t => {
  const { root, base, local } = fixture(t);
  assert.equal(loadWorkspaceConfig(base).configured, false); assert.ok(!fs.existsSync(base));
  fs.writeFileSync(base, `CONFIG_VERSION=1\nWORKSPACE_ID=one\nWORKSPACE_ROOT="${root}"`);
  fs.writeFileSync(local, 'WORKSPACE_ID=two');
  assert.equal(loadWorkspaceConfig(base).workspaceId, 'two'); assert.equal(loadWorkspaceConfig(base).workspaceRoot, root);
  fs.writeFileSync(local, 'WORKSPACE_ROOT='); assert.equal(loadWorkspaceConfig(base).configured, false);
  fs.writeFileSync(local, 'WORKSPACE_ID='); assert.throws(() => loadWorkspaceConfig(base), /WORKSPACE_ID/);
  fs.writeFileSync(local, 'WORKSPACE_ROOT=./relative'); assert.throws(() => loadWorkspaceConfig(base), /绝对目录/);
  assert.equal(readWorkspaceSettings(base).configured, false);
});
test('obsolete workspace-console config is ignored even when the new local is absent', t => {
  const { root, base, local, legacy } = fixture(t);
  fs.writeFileSync(base, 'CONFIG_VERSION=1\nWORKSPACE_ROOT=\nWORKSPACE_ID=default');
  fs.writeFileSync(legacy, `workspace_root=${root}\nworkspace_id=old`);
  assert.equal(loadWorkspaceConfig(base).workspaceRoot, ''); assert.equal(loadWorkspaceConfig(base).workspaceId, 'default');
  fs.writeFileSync(local, 'WORKSPACE_ROOT='); assert.equal(loadWorkspaceConfig(base).workspaceRoot, '');
  fs.writeFileSync(local, 'broken'); assert.throws(() => loadWorkspaceConfig(base), /格式无效/);
  assert.equal(fs.readFileSync(legacy, 'utf8'), `workspace_root=${root}\nworkspace_id=old`);
});
test('connection reference, root and file boundary checks fail closed', t => {
  const { root, base } = fixture(t);
  fs.writeFileSync(base, 'CONFIG_VERSION=1\nFEISHU_CONNECTION_ID=missing'); assert.throws(() => loadWorkspaceConfig(base), /连接不匹配/);
  fs.writeFileSync(base, 'CONFIG_VERSION=2'); assert.throws(() => loadWorkspaceConfig(base), /版本1/);
  fs.writeFileSync(base, 'CONFIG_VERSION=1\nADAPTER=other'); assert.throws(() => loadWorkspaceConfig(base), /不受支持/);
  assert.equal(requireWorkspaceFile(root, 'workbench.conf'), base);
  assert.throws(() => requireWorkspaceFile(root, '..', 'outside'), /越过/);
  assert.throws(() => requireWorkspaceRoot(path.join(root, 'missing')), /根目录不存在/);
});
