import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { cleanWorktree, parseWorktreeList, resolveWorktreeTarget, validateWorktreeName } from './lib/worktree-cleanup.mjs';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('worktree 名称拒绝路径和上级目录', () => {
  assert.equal(validateWorktreeName('feature_demo-1.0'), 'feature_demo-1.0');
  for (const invalid of ['', '.', '..', '../demo', 'a/b', 'a\\b', 'G:\\demo']) {
    assert.throws(() => validateWorktreeName(invalid));
  }
});

test('worktree 目标固定在项目 .worktrees 单级目录', () => {
  const root = path.resolve('example-root');
  const result = resolveWorktreeTarget(root, 'demo');
  assert.equal(result.target, path.join(root, '.worktrees', 'demo'));
});

test('解析 Git worktree porcelain 输出', () => {
  const records = parseWorktreeList('worktree G:/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree G:/repo/.worktrees/demo\nHEAD def\nbranch refs/heads/demo\n');
  assert.equal(records.length, 2);
  assert.equal(records[1].branch, 'refs/heads/demo');
});

test('只清理干净且已合并的项目临时 worktree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-worktree-cleanup-'));
  try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.name', 'Relay Test']);
    git(root, ['config', 'user.email', 'relay-test@example.invalid']);
    git(root, ['config', 'core.safecrlf', 'false']);
    fs.writeFileSync(path.join(root, 'README.md'), 'test\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-m', '初始化']);
    git(root, ['branch', 'feature-clean']);
    fs.mkdirSync(path.join(root, '.worktrees'), { recursive: true });
    git(root, ['worktree', 'add', path.join(root, '.worktrees', 'feature-clean'), 'feature-clean']);

    const result = cleanWorktree(root, 'feature-clean');
    assert.equal(result.branch, 'feature-clean');
    assert.equal(fs.existsSync(path.join(root, '.worktrees', 'feature-clean')), false);
    assert.equal(git(root, ['branch', '--list', 'feature-clean']), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
