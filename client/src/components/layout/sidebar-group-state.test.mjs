import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  expandSidebarProjectGroup,
  isSidebarGroupExpanded,
  toggleSidebarGroup,
} from './sidebar-group-state.ts';

test('具体项目组默认折叠，顶层分组默认展开', () => {
  assert.equal(isSidebarGroupExpanded({}, 'p-project-1'), false);
  assert.equal(isSidebarGroupExpanded({}, 'pinned'), true);
  assert.equal(isSidebarGroupExpanded({}, 'projects'), true);
});

test('项目组首次点击可以正常展开并继续切换', () => {
  const expanded = toggleSidebarGroup({}, 'p-project-1');
  assert.equal(isSidebarGroupExpanded(expanded, 'p-project-1'), true);

  const collapsed = toggleSidebarGroup(expanded, 'p-project-1');
  assert.equal(isSidebarGroupExpanded(collapsed, 'p-project-1'), false);
});

test('恢复会话时只展开其所属项目组', () => {
  const expanded = expandSidebarProjectGroup({}, 'project-2');

  assert.equal(isSidebarGroupExpanded(expanded, 'p-project-2'), true);
  assert.equal(isSidebarGroupExpanded(expanded, 'p-project-1'), false);
});

test('侧栏恢复历史会话时接入所属项目组展开逻辑', () => {
  const sidebar = fs.readFileSync(new URL('Sidebar.tsx', import.meta.url), 'utf8');
  const restoreBranch = sidebar.slice(
    sidebar.indexOf('if (restored.activeSessionId)'),
    sidebar.indexOf("setActiveSession('')"),
  );

  assert.match(restoreBranch, /expandSidebarProjectGroup\(current, restoredProjectId\)/);
});
