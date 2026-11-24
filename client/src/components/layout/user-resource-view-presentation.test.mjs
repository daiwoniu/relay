import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sidebar = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
const workbench = readFileSync(new URL('./SidebarWorkbench.tsx', import.meta.url), 'utf8');
const dialog = readFileSync(new URL('./UserResourceDialog.tsx', import.meta.url), 'utf8');
const chatView = readFileSync(new URL('../chat/ChatView.tsx', import.meta.url), 'utf8');

test('默认显示新对话，管理视图在同一位置显示资源状态并支持退出', () => {
  assert.match(workbench, /resourceViewType === 'mine' \? <div[\s\S]*?新对话[\s\S]*?: <div className="sidebar-resource-view/);
  assert.match(workbench, /isAdmin && <button[\s\S]*?我的资源/);
  assert.match(sidebar, /<SidebarWorkbench[^>]*isAdmin=\{user\?\.role === 'admin'\}/);
  assert.match(workbench, /aria-label="切换用户资源"/);
  assert.match(workbench, /aria-label="退出用户资源视图"/);
  assert.match(sidebar, /restorePersonalResourceView/);
  assert.doesNotMatch(sidebar, /<SidebarAccountFilter/);
});

test('用户资源面板支持我的、指定账号、全部用户和账号搜索', () => {
  assert.match(dialog, /title="用户资源"/);
  assert.match(dialog, /选择要查看的账号/);
  assert.match(dialog, /我的资源/);
  assert.match(dialog, /全部用户资源/);
  assert.match(dialog, /搜索昵称或用户名/);
  assert.match(dialog, /listUsers/);
});

test('指定账号不重复显示归属，全部用户继续展示 owner', () => {
  assert.match(sidebar, /const showResourceOwner = accountScope === 'all' && !ownerFilterId/);
  assert.match(sidebar, /showOwner=\{showResourceOwner\}/);
});

test('管理视图没有选中会话时只提供浏览空态且不能创建会话', () => {
  assert.match(chatView, /const managementBrowseEmpty = user\?\.role === 'admin' && sidebarAccountScope === 'all' && !activeSessionId/);
  assert.match(chatView, /managementBrowseEmpty \? <div[\s\S]*?请从左侧选择会话/);
  assert.match(chatView, /if \(managementBrowseEmpty\) return false/);
  assert.match(sidebar, /if \(accountScope === 'all'\) return/);
  assert.match(sidebar, /\.\.\.\(canCreateSidebarProjectSession\(menuProject, menuInteractionPolicy\.canOrganize\) \? \[\{\s*id: 'new-session'/);
});

test('全部用户视图在资源栏提供显示全部项目开关且仅该视图显示', () => {
  assert.match(sidebar, /const hidingEmptyProjects = accountScope === 'all' && !ownerFilterId && !showAllProjects/);
  assert.match(sidebar, /showAllProjectsToggle=\{resourceViewType === 'all' \? \{ checked: showAllProjects, onToggle: toggleShowAllProjects \} : null\}/);
  assert.match(workbench, /showAllProjectsToggle && <Tooltip/);
  assert.match(workbench, /aria-pressed=\{showAllProjectsToggle\.checked\}/);
  assert.match(workbench, /aria-label="显示全部项目"/);
});

test('退出管理视图恢复完整个人会话或空白位置', () => {
  assert.match(sidebar, /pendingProjectPath: string \| null/);
  assert.match(sidebar, /autoOpenProjectPicker: boolean/);
  assert.match(sidebar, /projectSelectionLocked: boolean/);
  assert.match(sidebar, /setPendingProject\(previous\.pendingProjectPath\)/);
  assert.match(sidebar, /autoOpenProjectPicker: previous\.autoOpenProjectPicker/);
  assert.match(sidebar, /projectSelectionLocked: previous\.projectSelectionLocked/);
  assert.match(sidebar, /setPendingProject\(null\);[\s\S]*?if \(firstProject\) setCurrentProject\(firstProject\.id\)/);
});
