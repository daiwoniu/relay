import assert from 'node:assert/strict';
import test from 'node:test';
import { formatGitDiffHunkHeader } from './git-diff-hunk.ts';

test('普通变更显示变更前后行号', () => {
  assert.equal(
    formatGitDiffHunkHeader('@@ -166,14 +167,42 @@ export default function RightPanelContent({', false),
    '变更前第 166–179 行 → 变更后第 167–208 行',
  );
  assert.equal(formatGitDiffHunkHeader('@@ -8 +9 @@', false), '变更前第 8 行 → 变更后第 9 行');
});

test('仅真正新增的文件显示新增文件说明', () => {
  assert.equal(formatGitDiffHunkHeader('@@ -0,0 +1,57 @@', true), '新增文件 · 第 1–57 行');
  assert.equal(formatGitDiffHunkHeader('@@ -0,0 +1,57 @@', false), '变更前无对应行 → 变更后第 1–57 行');
});

test('不认识的标记保持原样', () => {
  assert.equal(formatGitDiffHunkHeader('@@@ -1,2 -3,4 +5,6 @@@', false), '@@@ -1,2 -3,4 +5,6 @@@');
});
