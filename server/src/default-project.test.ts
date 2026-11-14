import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Project } from './db/queries.js';
import { DEFAULT_PROJECT_NAME, ensureDefaultProject, resolveRelayRoot, type DefaultProjectRepository } from './default-project.js';
import { ensureDefaultWorkspaceFiles } from './default-workspace.js';

function project(id: string, name: string, projectPath: string, isSystem: number, ownerUserId?: string | null): Project {
  return {
    id,
    name,
    path: projectPath,
    created_at: 1,
    updated_at: 1,
    pinned: 0,
    is_system: isSystem,
    owner_user_id: ownerUserId,
  };
}

function createRepository(initial: Project[] = []) {
  const projects = [...initial];
  const migrations: Array<{ id: string; projectPath: string; name: string; duplicateProjectId?: string }> = [];
  const repository: DefaultProjectRepository = {
    createProject(name, projectPath, isSystem = false, ownerUserId = null) {
      const created = project(`project-${projects.length + 1}`, name, projectPath, isSystem ? 1 : 0, ownerUserId);
      projects.push(created);
      return created;
    },
    getProjectByPath(projectPath) {
      return projects.find((item) => item.path === projectPath);
    },
    getProjectByPathForOwner(projectPath, ownerUserId) {
      return projects.find((item) => item.path === projectPath && item.owner_user_id === ownerUserId);
    },
    updateProject(id, updates) {
      const target = projects.find((item) => item.id === id);
      if (target) Object.assign(target, updates);
    },
    migrateDefaultProject(id, projectPath, name, duplicateProjectId) {
      migrations.push({ id, projectPath, name, duplicateProjectId });
      const duplicateIndex = projects.findIndex((item) => item.id === duplicateProjectId);
      if (duplicateIndex >= 0) projects.splice(duplicateIndex, 1);
      const target = projects.find((item) => item.id === id);
      if (target) Object.assign(target, { path: projectPath, name, is_system: 1 });
    },
  };
  return { projects, repository, migrations };
}

test('首次启动创建 workspace 目录和默认项目', () => {
  const relayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-default-project-'));
  try {
    const { projects, repository } = createRepository();
    const result = ensureDefaultProject(relayRoot, repository);

    assert.equal(result.action, 'created');
    assert.equal(result.projectId, projects[0].id);
    assert.equal(fs.statSync(path.join(relayRoot, 'workspace')).isDirectory(), true);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, DEFAULT_PROJECT_NAME);
    assert.equal(projects[0].path, path.join(relayRoot, 'workspace'));
    assert.equal(projects[0].is_system, 1);
  } finally {
    fs.rmSync(relayRoot, { recursive: true, force: true });
  }
});

test('默认项目创建后在 workspace 内补齐基础规则', () => {
  const relayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-default-project-rules-'));
  try {
    const { repository } = createRepository();
    const result = ensureDefaultProject(relayRoot, repository);
    const workspaceFiles = ensureDefaultWorkspaceFiles(result.workspacePath);

    assert.deepEqual(workspaceFiles.created, ['AGENTS.md', 'WORKBUDDY.md', 'README.md']);
    assert.equal(fs.existsSync(path.join(relayRoot, 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(result.workspacePath, 'AGENTS.md')), true);
  } finally {
    fs.rmSync(relayRoot, { recursive: true, force: true });
  }
});

test('旧根目录默认项目迁移到 workspace 并保留用户改名', () => {
  const relayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-default-project-migration-'));
  try {
    const legacy = project('legacy-id', '我的工作区', relayRoot, 1);
    const { projects, repository, migrations } = createRepository([legacy]);

    const result = ensureDefaultProject(relayRoot, repository);
    const workspaceFiles = ensureDefaultWorkspaceFiles(result.workspacePath);

    assert.equal(result.action, 'migrated');
    assert.equal(result.projectId, 'legacy-id');
    assert.equal(projects[0].id, 'legacy-id');
    assert.equal(projects[0].name, '我的工作区');
    assert.equal(projects[0].path, path.join(relayRoot, 'workspace'));
    assert.equal(migrations.length, 1);
    assert.deepEqual(workspaceFiles.created, ['AGENTS.md', 'WORKBUDDY.md', 'README.md']);
    assert.equal(fs.existsSync(path.join(relayRoot, 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(result.workspacePath, 'AGENTS.md')), true);
  } finally {
    fs.rmSync(relayRoot, { recursive: true, force: true });
  }
});

test('迁移自动生成的旧名称并合并重复 workspace 项目', () => {
  const relayRoot = path.resolve('D:/daiwoniu-relay');
  const workspacePath = path.join(relayRoot, 'workspace');
  const legacy = project('legacy-id', 'daiwoniu-relay', relayRoot, 1);
  const duplicate = project('workspace-id', 'workspace', workspacePath, 0);
  const { projects, repository, migrations } = createRepository([legacy, duplicate]);

  const result = ensureDefaultProject(relayRoot, repository, { mkdirSync() { return undefined; } });

  assert.equal(result.name, DEFAULT_PROJECT_NAME);
  assert.equal(result.projectId, 'legacy-id');
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, 'legacy-id');
  assert.equal(migrations[0].duplicateProjectId, 'workspace-id');
});

test('已存在的旧默认名称升级为新的默认项目名称', () => {
  const relayRoot = path.resolve('D:/relay');
  const workspace = project('workspace-id', 'Relay 工作区', path.join(relayRoot, 'workspace'), 1);
  const { projects, repository } = createRepository([workspace]);

  const result = ensureDefaultProject(relayRoot, repository, { mkdirSync() { return undefined; } });

  assert.equal(result.action, 'updated');
  assert.equal(result.name, DEFAULT_PROJECT_NAME);
  assert.equal(projects[0].name, DEFAULT_PROJECT_NAME);
});

test('已存在的默认 workspace 不会重复创建或覆盖用户改名', () => {
  const relayRoot = path.resolve('D:/relay');
  const workspace = project('workspace-id', '团队空间', path.join(relayRoot, 'workspace'), 1);
  const { projects, repository, migrations } = createRepository([workspace]);

  const result = ensureDefaultProject(relayRoot, repository, { mkdirSync() { return undefined; } });

  assert.equal(result.action, 'unchanged');
  assert.equal(result.projectId, 'workspace-id');
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, '团队空间');
  assert.equal(migrations.length, 0);
});

test('多账号启动只选择管理员自己的同目录默认项目', () => {
  const relayRoot = path.resolve('D:/relay');
  const workspacePath = path.join(relayRoot, 'workspace');
  const memberProject = project('member-project', '成员工作区', workspacePath, 1, 'member-user');
  const adminProject = project('admin-project', '管理员工作区', workspacePath, 1, 'admin-user');
  const { projects, repository } = createRepository([memberProject, adminProject]);

  const result = ensureDefaultProject(relayRoot, repository, { mkdirSync() { return undefined; } }, 'admin-user');

  assert.equal(result.projectId, 'admin-project');
  assert.equal(result.name, '管理员工作区');
  assert.equal(projects.length, 2);
});

test('多账号首次创建默认项目时写入管理员所有者', () => {
  const relayRoot = path.resolve('D:/relay');
  const { projects, repository } = createRepository([
    project('member-project', '成员工作区', path.join(relayRoot, 'workspace'), 1, 'member-user'),
  ]);

  const result = ensureDefaultProject(relayRoot, repository, { mkdirSync() { return undefined; } }, 'admin-user');

  assert.equal(result.action, 'created');
  assert.equal(projects.find((item) => item.id === result.projectId)?.owner_user_id, 'admin-user');
});

test('隔离验收可显式覆盖 Relay 根目录', () => {
  const defaultRoot = path.resolve('relay-default');
  const isolatedRoot = path.resolve('relay-isolated');
  assert.equal(resolveRelayRoot(defaultRoot, isolatedRoot), isolatedRoot);
  assert.equal(resolveRelayRoot(defaultRoot, ''), defaultRoot);
});
