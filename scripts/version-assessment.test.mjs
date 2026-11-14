import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyWorktreeEntries, collectVersionAssessment, findLastVersionChange, formatVersionAssessment, nextVersionCandidates } from './lib/version-assessment.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

test('计算产品版本候选值', () => {
  assert.deepEqual(nextVersionCandidates('0.1.0'), { patch: '0.1.1', minor: '0.2.0', major: '1.0.0' });
  assert.deepEqual(nextVersionCandidates('1.4.9-beta.1'), { patch: '1.4.9', minor: '1.5.0', major: '2.0.0' });
});

test('从 package 历史中跳过未改变版本的提交并找到真实版本基线', () => {
  const versions = new Map([
    ['c3', '0.2.0'], ['c3^', '0.2.0'],
    ['c2', '0.2.0'], ['c2^', '0.1.0'],
  ]);
  assert.deepEqual(findLastVersionChange(['c3', 'c2'], (revision) => versions.get(revision) ?? null), {
    commit: 'c2', version: '0.2.0', previousVersion: '0.1.0',
  });
});

test('区分未暂存、暂存和冲突状态', () => {
  assert.deepEqual(classifyWorktreeEntries([
    ' M client/src/App.tsx',
    '?? notes.txt',
    'M  scripts/tool.mjs',
    'UU shared.ts',
  ]), {
    stagedEntries: ['M  scripts/tool.mjs'],
    unstagedEntries: [' M client/src/App.tsx', '?? notes.txt'],
    conflictEntries: ['UU shared.ts'],
  });
});

test('汇总版本基线后的提交、文件和脏工作区证据', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-version-assessment-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"9.9.9"}');
    const responses = new Map([
      ['rev-parse HEAD', 'head123456789\n'],
      ['branch --show-current', 'main\n'],
      ['rev-parse --abbrev-ref --symbolic-full-name @{upstream}', 'origin/main\n'],
      ['rev-list --left-right --count origin/main...head123456789', '0\t2\n'],
      ['log --format=%H -- package.json', 'base\nolder\n'],
      ['show base:package.json', '{"version":"0.2.0"}'],
      ['show base^:package.json', '{"version":"0.1.0"}'],
      ['show head123456789:package.json', '{"version":"0.2.0"}'],
      ['log --reverse --date=short --format=%H%x09%ad%x09%s base..head123456789', 'a1\t2026-08-13\t修复消息状态\n'],
      ['diff --name-status base head123456789', 'M\tclient/src/App.tsx\nA\tscripts/new.mjs\n'],
      ['status --porcelain=v1', ' M client/src/App.tsx\n'],
    ]);
    const runGit = (_cwd, args, allowFailure) => {
      const key = args.join(' ');
      if (!responses.has(key)) {
        if (allowFailure) return { status: 1, stdout: '', stderr: 'missing' };
        throw new Error(`缺少测试响应：${key}`);
      }
      return { status: 0, stdout: responses.get(key), stderr: '' };
    };
    const result = collectVersionAssessment(root, { runGit });
    assert.equal(result.baseline.commit, 'base');
    assert.equal(result.currentVersion, '9.9.9');
    assert.equal(result.headVersion, '0.2.0');
    assert.equal(result.candidateBasisVersion, '0.2.0');
    assert.equal(result.candidates.patch, '0.2.1');
    assert.equal(result.commits.length, 1);
    assert.equal(result.files.length, 2);
    assert.equal(result.dirty, true);
    assert.deepEqual(result.upstreamComparison, { behind: 0, ahead: 2 });
    assert.equal(result.formalAssessmentReady, false);
    assert.doesNotMatch(result.formalAssessmentBlockers.join('\n'), /未提交变更/);
    assert.match(result.formalAssessmentBlockers.join('\n'), /工作区版本 9\.9\.9 与 HEAD 版本 0\.2\.0 不一致/);
    assert.match(result.formalAssessmentWarnings.join('\n'), /1 条未暂存或未跟踪变更/);
    assert.match(result.semanticReviewCommands[1], /git diff base\.\.head123456789/);
    assert.match(formatVersionAssessment(result), /本命令不自动定级/);
    assert.match(formatVersionAssessment(result), /可继续评估或推送已提交 HEAD/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('普通未暂存和未跟踪变更不阻塞已提交 HEAD 的正式评估', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-version-assessment-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.2.0"}');
    const common = new Map([
      ['rev-parse HEAD', 'head\n'], ['branch --show-current', 'main\n'],
      ['rev-parse --abbrev-ref --symbolic-full-name @{upstream}', 'origin/main\n'],
      ['rev-list --left-right --count origin/main...head', '0 1\n'],
      ['log --format=%H -- package.json', 'base\n'],
      ['show base:package.json', '{"version":"0.2.0"}'],
      ['show base^:package.json', '{"version":"0.1.0"}'],
      ['show head:package.json', '{"version":"0.2.0"}'],
      ['log --reverse --date=short --format=%H%x09%ad%x09%s base..head', ''],
      ['diff --name-status base head', ''],
      ['status --porcelain=v1', ' M local.ts\n?? scratch.txt\n'],
    ]);
    const runGit = (_cwd, args) => ({ status: 0, stdout: common.get(args.join(' ')) ?? '', stderr: '' });
    const result = collectVersionAssessment(root, { runGit });
    assert.equal(result.formalAssessmentReady, true);
    assert.deepEqual(result.formalAssessmentBlockers, []);
    assert.equal(result.unstagedEntries.length, 2);
    assert.match(result.formalAssessmentWarnings.join('\n'), /不会进入已提交 HEAD/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('暂存内容和冲突仍阻塞正式评估', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-version-assessment-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.2.0"}');
    const responses = new Map([
      ['rev-parse HEAD', 'head\n'], ['branch --show-current', 'main\n'],
      ['rev-parse --abbrev-ref --symbolic-full-name @{upstream}', 'origin/main\n'],
      ['rev-list --left-right --count origin/main...head', '0 1\n'],
      ['log --format=%H -- package.json', 'base\n'],
      ['show base:package.json', '{"version":"0.2.0"}'],
      ['show base^:package.json', '{"version":"0.1.0"}'],
      ['show head:package.json', '{"version":"0.2.0"}'],
      ['log --reverse --date=short --format=%H%x09%ad%x09%s base..head', ''],
      ['diff --name-status base head', ''],
      ['status --porcelain=v1', 'M  staged.ts\nUU conflict.ts\n'],
    ]);
    const runGit = (_cwd, args) => ({ status: 0, stdout: responses.get(args.join(' ')) ?? '', stderr: '' });
    const result = collectVersionAssessment(root, { runGit });
    assert.equal(result.formalAssessmentReady, false);
    assert.match(result.formalAssessmentBlockers.join('\n'), /暂存区存在 1 条/);
    assert.match(result.formalAssessmentBlockers.join('\n'), /存在 1 条冲突变更/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('merge 或 rebase 进行中即使暂存区为空也阻塞正式评估', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-version-assessment-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.2.0"}');
    const responses = new Map([
      ['rev-parse HEAD', 'head\n'], ['branch --show-current', 'main\n'],
      ['rev-parse --abbrev-ref --symbolic-full-name @{upstream}', 'origin/main\n'],
      ['rev-list --left-right --count origin/main...head', '0 1\n'],
      ['log --format=%H -- package.json', 'base\n'],
      ['show base:package.json', '{"version":"0.2.0"}'],
      ['show base^:package.json', '{"version":"0.1.0"}'],
      ['show head:package.json', '{"version":"0.2.0"}'],
      ['log --reverse --date=short --format=%H%x09%ad%x09%s base..head', ''],
      ['diff --name-status base head', ''], ['status --porcelain=v1', ''],
      ['rev-parse --git-path MERGE_HEAD', '.git/MERGE_HEAD\n'],
      ['rev-parse --git-path rebase-merge', '.git/rebase-merge\n'],
      ['rev-parse --git-path rebase-apply', '.git/rebase-apply\n'],
    ]);
    const runGit = (_cwd, args) => ({ status: 0, stdout: responses.get(args.join(' ')) ?? '', stderr: '' });
    const pathExists = (candidate) => candidate.endsWith(path.join('.git', 'rebase-merge'));
    const result = collectVersionAssessment(root, { runGit, pathExists });
    assert.equal(result.formalAssessmentReady, false);
    assert.deepEqual(result.repositoryOperations, ['rebase']);
    assert.match(result.formalAssessmentBlockers.join('\n'), /正在进行 rebase 操作/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('默认输出限制长列表并警告非 main 分支', () => {
  const result = {
    currentVersion: '0.1.0', headVersion: '0.1.0', versionModifiedInWorktree: false,
    formalAssessmentReady: false, formalAssessmentBlockers: ['当前分支不是 main：feature/demo'],
    candidates: { patch: '0.1.1', minor: '0.2.0', major: '1.0.0' },
    branch: 'feature/demo', head: 'a'.repeat(40),
    upstream: 'origin/feature/demo', upstreamComparison: { behind: 0, ahead: 1 },
    baseline: { version: '0.1.0', commit: 'b'.repeat(40) }, range: 'base..head',
    commits: Array.from({ length: 25 }, (_, index) => ({ commit: String(index).padStart(40, '0'), date: '2026-08-13', subject: `提交 ${index}` })),
    files: Array.from({ length: 25 }, (_, index) => ({ status: 'M', paths: [`file-${index}.ts`] })),
    dirty: false, dirtyEntries: [], formalAssessmentWarnings: [],
  };
  const output = formatVersionAssessment(result);
  assert.match(output, /省略较早的 5 个提交/);
  assert.match(output, /省略 5 个文件/);
  assert.doesNotMatch(output, /提交 0\n/);
  assert.match(output, /当前为 feature\/demo/);
  assert.equal(JSON.parse(JSON.stringify(result)).commits.length, 25);
  assert.equal(JSON.parse(JSON.stringify(result)).files.length, 25);
});

test('拒绝无法解析的 upstream 领先落后计数', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-version-assessment-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.2.0"}');
    const responses = new Map([
      ['rev-parse HEAD', 'head\n'],
      ['branch --show-current', 'main\n'],
      ['rev-parse --abbrev-ref --symbolic-full-name @{upstream}', 'origin/main\n'],
      ['rev-list --left-right --count origin/main...head', 'unknown\n'],
    ]);
    const runGit = (_cwd, args) => ({ status: 0, stdout: responses.get(args.join(' ')) ?? '', stderr: '' });
    assert.throws(() => collectVersionAssessment(root, { runGit }), /无法解析 origin\/main/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('真实临时 Git 仓库返回超过文本上限的完整累计范围', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-version-assessment-git-'));
  try {
    runGit(root, ['init', '-b', 'main']);
    runGit(root, ['config', 'user.name', 'Relay Test']);
    runGit(root, ['config', 'user.email', 'relay-test@example.invalid']);
    runGit(root, ['config', 'core.autocrlf', 'false']);
    runGit(root, ['config', 'core.safecrlf', 'false']);
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.1.0"}');
    runGit(root, ['add', 'package.json']);
    runGit(root, ['commit', '-m', '建立版本基线']);
    for (let index = 0; index < 25; index += 1) {
      const filename = `file-${String(index).padStart(2, '0')}.txt`;
      fs.writeFileSync(path.join(root, filename), `content ${index}\n`);
      runGit(root, ['add', filename]);
      runGit(root, ['commit', '-m', `累计改动 ${index}`]);
    }
    const assessment = collectVersionAssessment(root);
    assert.equal(assessment.commits.length, 25);
    assert.equal(assessment.files.length, 25);
    assert.match(formatVersionAssessment(assessment), /省略较早的 5 个提交/);
    assert.match(formatVersionAssessment(assessment), /省略 5 个文件/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('npm silent JSON 输出可直接解析且保留完整累计范围数据', () => {
  const command = process.platform === 'win32' ? process.env.ComSpec : 'npm';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm run --silent version:assess -- --json']
    : ['run', '--silent', 'version:assess', '--', '--json'];
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const assessment = JSON.parse(result.stdout);
  assert.equal(Array.isArray(assessment.commits), true);
  assert.equal(Array.isArray(assessment.files), true);
  assert.equal(typeof assessment.range, 'string');
  assert.equal(Array.isArray(assessment.semanticReviewCommands), true);
  assert.equal(assessment.upstream === null || typeof assessment.upstream === 'string', true);
  assert.equal(assessment.upstreamComparison === null
    || Object.keys(assessment.upstreamComparison).sort().join(',') === 'ahead,behind', true);
  assert.equal(typeof assessment.formalAssessmentReady, 'boolean');
  assert.equal(Array.isArray(assessment.formalAssessmentBlockers), true);
});
