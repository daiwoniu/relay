import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const rootPackage = JSON.parse(read('package.json'));
const clientPackage = JSON.parse(read('client/package.json'));
const clientLock = JSON.parse(read('client/package-lock.json'));
const serverPackage = JSON.parse(read('server/package.json'));
const serverLock = JSON.parse(read('server/package-lock.json'));

test('Relay 产品版本以根 package.json 为唯一运行时来源', () => {
  assert.match(rootPackage.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  assert.match(read('client/vite.config.ts'), /path\.resolve\(__dirname, '\.\.', 'package\.json'\)/);
  assert.match(read('client/src/components/layout/UserMenu.tsx'), /Relay v\{__RELAY_VERSION__\}/);
  assert.match(read('scripts/lib/help.mjs'), /new URL\('\.\.\/\.\.\/package\.json', import\.meta\.url\)/);
  assert.doesNotMatch(read('client/src/components/layout/UserMenu.tsx'), /Relay v\d+\.\d+\.\d+/);
});

test('根产品版本属于 production 前端构建指纹', () => {
  assert.match(read('scripts/lib/frontend-build.mjs'), /path\.join\(root, 'package\.json'\)/);
});

test('main 新增任意来源的待交付提交后必须累计评估且等待用户确认', () => {
  const policy = read('ai/docs/reference/versioning.md');
  const gitRule = read('ai/docs/rules/worktree-and-git.md');
  const rootScripts = rootPackage.scripts;
  assert.equal(rootScripts['version:assess'], 'node scripts/version-assessment.mjs');
  assert.match(policy, /只要 `main` 新增待交付提交/);
  assert.match(policy, /diff、关键提交、契约与迁移影响/);
  assert.match(policy, /不能把文件列表称为完整语义证据/);
  assert.match(policy, /用户确认建议后才修改根版本/);
  assert.match(gitRule, /git fetch origin/);
  assert.match(gitRule, /不落后最新 `origin\/main`/);
  assert.match(gitRule, /npm run --silent version:assess -- --json/);
  assert.match(gitRule, /直接提交、merge、cherry-pick 还是 revert/);
  assert.match(gitRule, /本地 HEAD、`origin\/main` 或待交付内容发生变化.*重新 fetch、重新评估/);
  assert.match(gitRule, /不能单独作为正式判断依据/);
  assert.match(gitRule, /版本选择是 push 的硬门禁/);
  assert.match(gitRule, /未明确选择前禁止 push/);
  assert.match(gitRule, /“提交推送”“继续”“弄吧”等泛化执行指令.*不代表选择保持旧版本/);
  assert.match(gitRule, /先前的版本选择随即失效/);
  assert.match(gitRule, /用户未确认前不得修改根 `package\.json`/);
  assert.match(gitRule, /版本变更使用独立提交/);
  assert.match(gitRule, /禁止夹带功能代码/);
  assert.match(gitRule, /未暂存或未跟踪的并行修改只披露.*不自动阻塞/s);
  assert.match(gitRule, /暂存区存在内容、存在冲突、仓库正处于 merge 或 rebase.*根版本.*未提交.*硬门禁/s);
  assert.match(gitRule, /共同文件.*跳过.*继续提交/s);
  assert.match(policy, /有效选择只有“升级到目标版本后推送”或“本次保持当前版本直接推送”/);
  assert.match(policy, /普通的提交、推送、继续或同意执行指令不能代替版本选择/);
  assert.match(policy, /先前的版本选择失效/);
  assert.match(policy, /未暂存或未跟踪的并行修改.*不改变已提交 HEAD 的评估范围.*不自动使版本选择失效/s);
});

test('私有前后端子工程不声明独立版本', () => {
  for (const [name, manifest, lockfile] of [
    ['client', clientPackage, clientLock],
    ['server', serverPackage, serverLock],
  ]) {
    assert.equal(manifest.private, true, `${name} 必须保持 private`);
    assert.equal(Object.hasOwn(manifest, 'version'), false, `${name}/package.json 不得声明 version`);
    assert.equal(Object.hasOwn(lockfile, 'version'), false, `${name}/package-lock.json 顶层不得声明 version`);
    assert.equal(Object.hasOwn(lockfile.packages[''], 'version'), false, `${name} lockfile 根包不得声明 version`);
  }

  const policy = read('ai/docs/reference/versioning.md');
  assert.match(policy, /只维护一个面向用户的产品版本/);
  assert.match(policy, /不拆分前端产品版本和后端产品版本/);
  assert.match(policy, /私有子工程，不声明 `version`/);
  assert.match(policy, /RELAY_PROTOCOL_VERSION.*产品版本独立递增/s);
});
