import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');

test('项目菜单加载后端权威删除影响且加载期间保守禁用', () => {
  assert.match(source, /const openProjectMenu[\s\S]*?setProjectMenuDeletionImpact\(\{ projectId: project\.id, status: 'loading', impact: null \}\)[\s\S]*?getProjectDeletionImpact\(project\.id\)/);
  assert.match(source, /const projectDeleteMenuState = menuProject[\s\S]*?getProjectDeleteMenuState/);
  assert.match(source, /id: 'delete'[\s\S]*?label: '删除项目'[\s\S]*?disabled: projectDeleteMenuState\.disabled/);
  assert.doesNotMatch(source, /menuProjectHasInProgressSession/);
});

test('项目删除动作要求权威菜单状态允许', () => {
  assert.match(source, /const handleProjectDeleteStart[\s\S]*?const deleteState = getProjectDeleteMenuState\(Boolean\(project\.is_system\), menuState, false, Boolean\(project\.deletion_protected\), user\?\.defaultProjectId === project\.id\)[\s\S]*?if \(deleteState\.disabled\)/);
  assert.match(source, /const confirmDelete[\s\S]*?getProjectDeletionImpact\(deleteConfirm\.project\.id\)[\s\S]*?inProgressSessionCount > 0/);
  assert.match(source, /error instanceof ApiError && error\.status === 409/);
});
