import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_WORKSPACE_TEMPLATES,
  ensureDefaultWorkspaceFiles,
  ensureProjectFiles,
  type DefaultWorkspaceFilesystem,
} from './default-workspace.js';

function withWorkspace(run: (workspacePath: string) => void): void {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-default-workspace-'));
  try {
    run(workspacePath);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

test('空目录创建三份默认规则文件', () => {
  withWorkspace((workspacePath) => {
    const result = ensureDefaultWorkspaceFiles(workspacePath);

    assert.deepEqual(result.created, ['AGENTS.md', 'WORKBUDDY.md', 'README.md']);
    for (const [filename, template] of Object.entries(DEFAULT_WORKSPACE_TEMPLATES)) {
      assert.equal(fs.readFileSync(path.join(workspacePath, filename), 'utf8'), template);
    }
    assert.match(DEFAULT_WORKSPACE_TEMPLATES['AGENTS.md'], /Relay 项目 AI 入口/);
    assert.match(DEFAULT_WORKSPACE_TEMPLATES['AGENTS.md'], /WORKBUDDY\.md/);
    assert.match(DEFAULT_WORKSPACE_TEMPLATES['AGENTS.md'], /覆盖源码仓库根目录/);
    assert.match(DEFAULT_WORKSPACE_TEMPLATES['AGENTS.md'], /不得读取或写入源码仓库的 .*`ai\/STATUS\.md`/);
    assert.match(DEFAULT_WORKSPACE_TEMPLATES['AGENTS.md'], /不得使用源码仓库的任务登记.*Git 提交或推送流程/);
    assert.match(DEFAULT_WORKSPACE_TEMPLATES['WORKBUDDY.md'], /高影响、不可逆或越界/);
    assert.match(DEFAULT_WORKSPACE_TEMPLATES['WORKBUDDY.md'], /验证/);
    assert.match(DEFAULT_WORKSPACE_TEMPLATES['WORKBUDDY.md'], /处理过程和最终回复默认使用中文/);
    assert.match(DEFAULT_WORKSPACE_TEMPLATES['README.md'], /首次登记或恢复项目/);
  });
});

test('通用项目初始化与默认工作区初始化共享同一套非覆盖语义', () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-project-files-'));
  try {
    assert.deepEqual(ensureProjectFiles(workspacePath).created, ['AGENTS.md', 'WORKBUDDY.md', 'README.md']);
    assert.deepEqual(ensureDefaultWorkspaceFiles(workspacePath).created, []);
    assert.match(fs.readFileSync(path.join(workspacePath, 'README.md'), 'utf8'), /首次登记或恢复项目/);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('已有文件永不覆盖且只补齐缺失文件', () => {
  withWorkspace((workspacePath) => {
    const customRules = '# 我的规则\n';
    fs.writeFileSync(path.join(workspacePath, 'WORKBUDDY.md'), customRules, 'utf8');

    const result = ensureDefaultWorkspaceFiles(workspacePath);

    assert.deepEqual(result.created, ['AGENTS.md', 'README.md']);
    assert.equal(fs.readFileSync(path.join(workspacePath, 'WORKBUDDY.md'), 'utf8'), customRules);
    const readme = fs.readFileSync(path.join(workspacePath, 'README.md'), 'utf8');
    assert.match(readme, /`AGENTS\.md`：Relay 新增的 AI 自动发现入口，引导 AI 阅读项目已有的 `WORKBUDDY\.md`/);
    assert.match(readme, /`WORKBUDDY\.md`：项目已有的规则文件，Relay 保留原内容/);
  });
});

test('已有 AGENTS 时缺失的 WORKBUDDY 只引导阅读项目原有规则', () => {
  withWorkspace((workspacePath) => {
    const customAgents = '# 项目自有规则\n';
    fs.writeFileSync(path.join(workspacePath, 'AGENTS.md'), customAgents, 'utf8');

    const result = ensureProjectFiles(workspacePath);

    assert.deepEqual(result.created, ['WORKBUDDY.md', 'README.md']);
    assert.equal(fs.readFileSync(path.join(workspacePath, 'AGENTS.md'), 'utf8'), customAgents);
    assert.equal(
      fs.readFileSync(path.join(workspacePath, 'WORKBUDDY.md'), 'utf8'),
      `# 默认工作区 AI 入口

开始处理本项目中的任何任务前，必须完整阅读并遵守同目录的 \`AGENTS.md\`。

如果更深层目录存在更具体的规则文件，应同时遵守；更具体的规则可以补充当前规则，但不能降低安全边界。
`,
    );
    assert.doesNotMatch(
      fs.readFileSync(path.join(workspacePath, 'WORKBUDDY.md'), 'utf8'),
      /处理过程和最终回复默认使用中文/,
    );
    const readme = fs.readFileSync(path.join(workspacePath, 'README.md'), 'utf8');
    assert.match(readme, /`AGENTS\.md`：项目已有的 AI 规则文件，Relay 保留原内容/);
    assert.match(readme, /`WORKBUDDY\.md`：Relay 新增的兼容入口，只引导 AI 阅读项目已有的 `AGENTS\.md`/);
  });
});

test('AGENTS 和 WORKBUDDY 都已有时 README 中性描述并保留两份规则', () => {
  withWorkspace((workspacePath) => {
    fs.writeFileSync(path.join(workspacePath, 'AGENTS.md'), '# agents\n', 'utf8');
    fs.writeFileSync(path.join(workspacePath, 'WORKBUDDY.md'), '# workbuddy\n', 'utf8');

    const result = ensureProjectFiles(workspacePath);

    assert.deepEqual(result.created, ['README.md']);
    const readme = fs.readFileSync(path.join(workspacePath, 'README.md'), 'utf8');
    assert.match(readme, /`AGENTS\.md`：项目已有的 AI 规则文件，Relay 保留原内容/);
    assert.match(readme, /`WORKBUDDY\.md`：项目已有的规则文件，Relay 保留原内容/);
  });
});

test('重复执行不改写文件，删除后只恢复缺失文件', () => {
  withWorkspace((workspacePath) => {
    ensureDefaultWorkspaceFiles(workspacePath);
    const customReadme = '# 用户说明\n';
    fs.writeFileSync(path.join(workspacePath, 'README.md'), customReadme, 'utf8');

    assert.deepEqual(ensureDefaultWorkspaceFiles(workspacePath).created, []);

    fs.rmSync(path.join(workspacePath, 'AGENTS.md'));
    const restored = ensureDefaultWorkspaceFiles(workspacePath);

    assert.deepEqual(restored.created, ['AGENTS.md']);
    assert.equal(fs.readFileSync(path.join(workspacePath, 'README.md'), 'utf8'), customReadme);
  });
});

test('并发创建产生 EEXIST 且目标为普通文件时视为已存在', () => {
  const filesystem: DefaultWorkspaceFilesystem = {
    writeFileSync(filePath, content) {
      fs.writeFileSync(filePath, content, { encoding: 'utf8' });
      throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
    },
    statSync(filePath) {
      return fs.statSync(filePath);
    },
  };

  withWorkspace((workspacePath) => {
    const result = ensureDefaultWorkspaceFiles(workspacePath, filesystem);
    assert.deepEqual(result.created, []);
    assert.equal(fs.statSync(path.join(workspacePath, 'AGENTS.md')).isFile(), true);
  });
});

test('同名目录不能冒充规则文件', () => {
  withWorkspace((workspacePath) => {
    const targetPath = path.join(workspacePath, 'AGENTS.md');
    fs.mkdirSync(targetPath);

    assert.throws(
      () => ensureDefaultWorkspaceFiles(workspacePath),
      (error: unknown) => error instanceof Error
        && error.message.includes('初始化默认项目文件失败')
        && error.message.includes(targetPath),
    );
  });
});

test('真实写入错误包含目标文件路径', () => {
  const filesystem: DefaultWorkspaceFilesystem = {
    writeFileSync() {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    },
    statSync(filePath) {
      return fs.statSync(filePath);
    },
  };

  withWorkspace((workspacePath) => {
    const targetPath = path.join(workspacePath, 'AGENTS.md');
    assert.throws(
      () => ensureDefaultWorkspaceFiles(workspacePath, filesystem),
      (error: unknown) => error instanceof Error
        && error.message.includes(targetPath)
        && error.message.includes('permission denied'),
    );
  });
});

test('启动流程在服务监听前初始化默认工作区规则', () => {
  const entrySource = fs.readFileSync(new URL('managed-entry.ts', import.meta.url), 'utf8');
  const initializePosition = entrySource.indexOf('await ensureProjectFilesAsync(personalWorkspacePath');
  const listenPosition = entrySource.indexOf('await listenStoredManagedApplication(');

  assert.notEqual(initializePosition, -1);
  assert.notEqual(listenPosition, -1);
  assert.equal(initializePosition < listenPosition, true);
  assert.match(entrySource, /catch\(error\)\{[\s\S]*?process\.exitCode=1/);
});
