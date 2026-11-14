import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function defaultRunGit(root, args, allowFailure = false) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(result.error?.message || result.stderr.trim() || `git ${args.join(' ')} 执行失败`);
  }
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function parseManifestVersion(content, source) {
  try {
    const version = JSON.parse(content).version;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`${source} 缺少有效 SemVer`);
    }
    return version;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${source} 不是有效 JSON`);
    throw error;
  }
}

export function nextVersionCandidates(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(version);
  if (!match) throw new Error(`无效产品版本：${version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return {
    patch: match[4] ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`,
    minor: `${major}.${minor + 1}.0`,
    major: `${major + 1}.0.0`,
  };
}

export function findLastVersionChange(commitHashes, loadVersion) {
  for (const commit of commitHashes) {
    const version = loadVersion(commit);
    const parentVersion = loadVersion(`${commit}^`, true);
    if (parentVersion !== version) return { commit, version, previousVersion: parentVersion };
  }
  throw new Error('Git 历史中未找到产品版本变化提交');
}

export function classifyWorktreeEntries(entries) {
  const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
  const stagedEntries = [];
  const unstagedEntries = [];
  const conflictEntries = [];
  for (const entry of entries) {
    const code = entry.slice(0, 2);
    if (conflictCodes.has(code)) {
      conflictEntries.push(entry);
      continue;
    }
    if (code[0] !== ' ' && code[0] !== '?') stagedEntries.push(entry);
    if (code === '??' || code[1] !== ' ') unstagedEntries.push(entry);
  }
  return { stagedEntries, unstagedEntries, conflictEntries };
}

function collectRepositoryOperations(root, git, pathExists) {
  const markers = [
    ['merge', 'MERGE_HEAD'],
    ['rebase', 'rebase-merge'],
    ['rebase', 'rebase-apply'],
  ];
  const operations = new Set();
  for (const [operation, marker] of markers) {
    const result = git(['rev-parse', '--git-path', marker], true);
    const markerPath = result.status === 0 ? result.stdout.trim() : '';
    if (markerPath && pathExists(path.isAbsolute(markerPath) ? markerPath : path.join(root, markerPath))) {
      operations.add(operation);
    }
  }
  return [...operations];
}

export function collectVersionAssessment(root, options = {}) {
  const runGit = options.runGit || defaultRunGit;
  const pathExists = options.pathExists || fs.existsSync;
  const git = (args, allowFailure = false) => runGit(root, args, allowFailure);
  const manifestPath = path.join(root, 'package.json');
  const workingVersion = parseManifestVersion(fs.readFileSync(manifestPath, 'utf8'), '根 package.json');
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  const branch = git(['branch', '--show-current']).stdout.trim() || null;
  const upstreamResult = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], true);
  const upstream = upstreamResult.status === 0 ? upstreamResult.stdout.trim() || null : null;
  let upstreamComparison = null;
  if (upstream) {
    const counts = git(['rev-list', '--left-right', '--count', `${upstream}...${head}`]).stdout.trim().split(/\s+/).map(Number);
    if (counts.length !== 2 || counts.some((count) => !Number.isInteger(count) || count < 0)) {
      throw new Error(`无法解析 ${upstream} 与 HEAD 的领先/落后计数`);
    }
    upstreamComparison = { behind: counts[0], ahead: counts[1] };
  }
  const commitHashes = git(['log', '--format=%H', '--', 'package.json']).stdout.trim().split(/\r?\n/).filter(Boolean);
  const loadVersion = (revision, allowMissing = false) => {
    const result = git(['show', `${revision}:package.json`], true);
    if (result.status !== 0) {
      if (allowMissing) return null;
      throw new Error(`无法读取 ${revision} 的根 package.json`);
    }
    return parseManifestVersion(result.stdout, `${revision}:package.json`);
  };
  const baseline = findLastVersionChange(commitHashes, loadVersion);
  const headVersion = loadVersion(head);
  const range = `${baseline.commit}..${head}`;
  const commits = git(['log', '--reverse', '--date=short', '--format=%H%x09%ad%x09%s', range]).stdout
    .trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const [commit, date, ...subject] = line.split('\t');
      return { commit, date, subject: subject.join('\t') };
    });
  const files = git(['diff', '--name-status', baseline.commit, head]).stdout
    .trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const [status, ...names] = line.split('\t');
      return { status, paths: names };
    });
  const dirtyEntries = git(['status', '--porcelain=v1']).stdout.split(/\r?\n/).filter(Boolean);
  const { stagedEntries, unstagedEntries, conflictEntries } = classifyWorktreeEntries(dirtyEntries);
  const repositoryOperations = collectRepositoryOperations(root, git, pathExists);
  const versionModifiedInWorktree = workingVersion !== headVersion;
  const formalAssessmentBlockers = [];
  const formalAssessmentWarnings = [];
  if (branch !== 'main') formalAssessmentBlockers.push(`当前分支不是 main：${branch || '(detached)'}`);
  if (!upstream) formalAssessmentBlockers.push('当前分支没有 upstream');
  else {
    if (upstream !== 'origin/main') formalAssessmentBlockers.push(`main upstream 不是 origin/main：${upstream}`);
    if (upstreamComparison.behind > 0) formalAssessmentBlockers.push(`当前 HEAD 落后 ${upstream} ${upstreamComparison.behind} 个提交`);
  }
  if (stagedEntries.length > 0) formalAssessmentBlockers.push(`暂存区存在 ${stagedEntries.length} 条待提交变更`);
  if (conflictEntries.length > 0) formalAssessmentBlockers.push(`工作区存在 ${conflictEntries.length} 条冲突变更`);
  if (repositoryOperations.length > 0) formalAssessmentBlockers.push(`仓库正在进行 ${repositoryOperations.join('/')} 操作`);
  if (versionModifiedInWorktree) formalAssessmentBlockers.push(`工作区版本 ${workingVersion} 与 HEAD 版本 ${headVersion} 不一致`);
  if (unstagedEntries.length > 0) {
    formalAssessmentWarnings.push(`工作区存在 ${unstagedEntries.length} 条未暂存或未跟踪变更；它们不会进入已提交 HEAD，推送前仍需确认暂存区为空`);
  }
  return {
    currentVersion: workingVersion,
    headVersion,
    versionModifiedInWorktree,
    candidateBasisVersion: headVersion,
    candidates: nextVersionCandidates(headVersion),
    branch,
    head,
    upstream,
    upstreamComparison,
    baseline,
    range,
    commits,
    files,
    dirty: dirtyEntries.length > 0,
    dirtyEntries,
    stagedEntries,
    unstagedEntries,
    conflictEntries,
    repositoryOperations,
    formalAssessmentReady: formalAssessmentBlockers.length === 0,
    formalAssessmentBlockers,
    formalAssessmentWarnings,
    semanticReviewCommands: [
      `git diff --stat ${range}`,
      `git diff ${range}`,
      `git log --reverse --format=fuller ${range}`,
    ],
  };
}

export function formatVersionAssessment(result) {
  const displayLimit = 20;
  const displayedCommits = result.commits.slice(-displayLimit);
  const displayedFiles = result.files.slice(-displayLimit);
  const lines = [
    `Relay 当前产品版本：${result.currentVersion}`,
    `当前分支 / HEAD：${result.branch || '(detached)'} / ${result.head.slice(0, 12)}`,
    `版本基线：${result.baseline.version} @ ${result.baseline.commit.slice(0, 12)}`,
    `累计范围：${result.range}`,
    `累计提交：${result.commits.length} 个`,
  ];
  if (result.commits.length > displayLimit) lines.push(`  … 省略较早的 ${result.commits.length - displayLimit} 个提交；使用 --json 获取完整范围数据`);
  for (const item of displayedCommits) lines.push(`  ${item.commit.slice(0, 8)}  ${item.date}  ${item.subject}`);
  lines.push(`累计文件：${result.files.length} 个`);
  if (result.files.length > displayLimit) lines.push(`  … 省略 ${result.files.length - displayLimit} 个文件；使用 --json 获取完整范围数据`);
  for (const item of displayedFiles) lines.push(`  ${item.status.padEnd(3)} ${item.paths.join(' -> ')}`);
  lines.push(`候选版本：Patch ${result.candidates.patch} / Minor ${result.candidates.minor} / Major ${result.candidates.major}`);
  if (result.branch !== 'main') lines.push(`分支警告：当前为 ${result.branch || '(detached)'}，正式建议必须在 main 最新 HEAD 上重新评估`);
  if (!result.upstream) lines.push('上游警告：当前分支没有可用的 upstream；正式评估前必须确认最新远端 main');
  else if (result.upstreamComparison.behind > 0) lines.push(`上游警告：当前 HEAD 落后 ${result.upstream} ${result.upstreamComparison.behind} 个提交，不能形成正式建议`);
  else lines.push(`上游状态：相对 ${result.upstream} 领先 ${result.upstreamComparison.ahead} 个、落后 0 个提交`);
  lines.push(result.dirty
    ? `工作区：存在 ${result.dirtyEntries.length} 条未提交变更；只要暂存区为空、无冲突且 HEAD 与远端未变化，可继续评估或推送已提交 HEAD`
    : '工作区：干净');
  for (const warning of result.formalAssessmentWarnings || []) lines.push(`提示：${warning}`);
  if (result.versionModifiedInWorktree) lines.push(`注意：工作区根版本 ${result.currentVersion} 与 HEAD 版本 ${result.headVersion} 不一致`);
  lines.push(result.formalAssessmentReady
    ? '正式评估条件：就绪（仍需确认已执行最新 git fetch origin）'
    : `正式评估条件：未就绪；${result.formalAssessmentBlockers.join('；')}`);
  lines.push('语义结论：JSON 只固定评估范围；还需审查该范围的 diff 和关键提交后判断保持 / Patch / Minor / Major，本命令不自动定级。');
  return lines.join('\n');
}
