import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEPENDENCY_LINK_PATHS = ['node_modules', path.join('client', 'node_modules'), path.join('server', 'node_modules')];

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function runGit(cwd, args, allowFailure = false) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  if (result.error) throw new Error(`无法执行 Git：${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `Git 命令失败（${result.status}）`).trim());
  }
  return result;
}

export function validateWorktreeName(input) {
  const name = String(input || '').trim();
  if (!name || !WORKTREE_NAME_PATTERN.test(name) || name === '.' || name === '..') {
    throw new Error('worktree 名称只能是单级字母、数字、点、下划线或短横线');
  }
  return name;
}

export function resolveWorktreeTarget(root, input) {
  const name = validateWorktreeName(input);
  const worktreesRoot = path.resolve(root, '.worktrees');
  const target = path.resolve(worktreesRoot, name);
  if (path.dirname(target) !== worktreesRoot) throw new Error('目标必须位于项目 .worktrees 目录内');
  return { name, worktreesRoot, target };
}

export function parseWorktreeList(output) {
  return output.trim().split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const record = {};
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(' ');
      if (separator < 0) record[line] = true;
      else record[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return record;
  });
}

export function listProjectWorktrees(root) {
  const worktreesRoot = comparablePath(path.resolve(root, '.worktrees'));
  return parseWorktreeList(runGit(root, ['worktree', 'list', '--porcelain']).stdout)
    .filter((record) => typeof record.worktree === 'string')
    .filter((record) => path.dirname(comparablePath(record.worktree)) === worktreesRoot);
}

function removeDependencyJunctions(target) {
  for (const relativePath of DEPENDENCY_LINK_PATHS) {
    const candidate = path.join(target, relativePath);
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) fs.rmSync(candidate, { force: true });
  }
}

export function inspectWorktree(root, input) {
  const { name, target } = resolveWorktreeTarget(root, input);
  const record = listProjectWorktrees(root).find((entry) => comparablePath(entry.worktree) === comparablePath(target));
  if (!record) throw new Error(`未找到已登记的临时 worktree：${name}`);
  if (!fs.existsSync(target)) throw new Error(`worktree 目录不存在：${target}`);

  const status = runGit(target, ['status', '--porcelain']).stdout.trim();
  if (status) throw new Error(`worktree 存在未提交修改，拒绝清理：${name}`);
  if (typeof record.branch !== 'string' || !record.branch.startsWith('refs/heads/')) {
    throw new Error(`worktree 未关联普通本地分支，拒绝清理：${name}`);
  }
  const branch = record.branch.slice('refs/heads/'.length);
  if (branch === 'main') throw new Error('禁止清理 main 分支 worktree');

  const merged = runGit(root, ['merge-base', '--is-ancestor', branch, 'main'], true);
  if (merged.status !== 0) throw new Error(`分支尚未合并到 main，拒绝清理：${branch}`);
  return { name, target, branch };
}

export function cleanWorktree(root, input) {
  const inspected = inspectWorktree(root, input);
  removeDependencyJunctions(inspected.target);
  const removal = runGit(root, ['worktree', 'remove', inspected.target], true);
  if (removal.status !== 0) {
    const stillRegistered = listProjectWorktrees(root)
      .some((entry) => comparablePath(entry.worktree) === comparablePath(inspected.target));
    if (stillRegistered) throw new Error((removal.stderr || removal.stdout || 'Git worktree 清理失败').trim());
    if (fs.existsSync(inspected.target)) fs.rmSync(inspected.target, { recursive: true, force: true });
  }
  runGit(root, ['branch', '-d', inspected.branch]);
  return inspected;
}
