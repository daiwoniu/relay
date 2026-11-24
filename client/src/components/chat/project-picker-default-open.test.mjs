import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const inputSource = [
  './ChatInput.tsx',
  './ChatInputMetadataBar.tsx',
].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
const chatViewSource = readFileSync(new URL('./ChatView.tsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../layout/Sidebar.tsx', import.meta.url), 'utf8');
const sidebarNavigationSource = readFileSync(new URL('../layout/SidebarNavigationItems.tsx', import.meta.url), 'utf8');
const storeSource = readFileSync(new URL('../../stores/chat.ts', import.meta.url), 'utf8');

test('仅在空会话没有默认项目兜底时自动打开项目选择面板', () => {
  assert.match(inputSource, /activeSessionOpenVersion/);
  assert.match(inputSource, /lastAutoOpenedEmptySessionVersionRef/);
  assert.match(inputSource, /if \(!canSelectProject \|\| !autoOpenProjectPicker\) \{\s*setProjectMenuAnchor\(null\)/);
  assert.match(inputSource, /lastAutoOpenedEmptySessionVersionRef\.current === activeSessionOpenVersion/);
  assert.match(inputSource, /projectMenuButtonRef\.current\?\.getBoundingClientRect\(\)/);
  assert.match(inputSource, /setProjectMenuAnchor\(anchorRect\)/);
  assert.match(inputSource, /ref=\{projectMenuButtonRef\}/);
  assert.match(sidebarSource, /const handleNewChat = \(\) => \{[\s\S]*?closeAllOverlays\(\);[\s\S]*?flushSync\(\(\) => \{[\s\S]*?setActiveSession\('', \{ autoOpenProjectPicker: !defaultProjectId, projectSelectionLocked: false \}\)/);
});

test('顶部新会话入口使用个人默认项目时不自动打开项目面板', () => {
  assert.match(sidebarSource, /const defaultProjectId = resolveDefaultProjectId\(projects, user\?\.defaultProjectId\)/);
  assert.match(sidebarSource, /setActiveSession\('', \{ autoOpenProjectPicker: !defaultProjectId, projectSelectionLocked: false \}\)/);
});

test('项目选择面板只接收当前账号可选项目', () => {
  assert.match(inputSource, /const selectableProjects = filterSelectableProjects\(projects, user\?\.id\)/);
  assert.match(inputSource, /projects=\{selectableProjects\}/);
});

test('用户关闭项目面板后不会被普通重渲染反复打开', () => {
  assert.match(inputSource, /lastAutoOpenedEmptySessionVersionRef\.current = activeSessionOpenVersion;\s*setProjectMenuAnchor\(anchorRect\)/);
  assert.match(inputSource, /\}, \[activeSessionOpenVersion, autoOpenProjectPicker, canSelectProject\]\);/);
});

test('从项目加号或项目菜单新建会话时不自动打开项目选择面板', () => {
  assert.match(sidebarSource, /const handleProjectNewChat = \(projectId: string\) => \{[\s\S]*?setActiveSession\('', \{ autoOpenProjectPicker: false, projectSelectionLocked: false \}\)/);
  assert.match(sidebarSource, /onSelect: \(\) => handleProjectNewChat\(menuProject\.id\)/);
  assert.match(sidebarSource, /onProjectNewChat=\{handleProjectNewChat\}/);
  assert.match(sidebarNavigationSource, /onProjectNewChat\(project\.id\)/);
});

test('从全部项目创建的空会话锁定项目选择控件', () => {
  assert.match(inputSource, /const canSelectProject = !activeSessionId && !pendingRestoreSessionId && !projectSelectionLocked/);
});

test('删除当前会话进入空会话时保留项目且不打开项目选择面板', () => {
  assert.match(storeSource, /const removedSession = state\.sessions\.find\(\(session\) => session\.id === id\)/);
  assert.match(storeSource, /storeEmptyChatLocation\([\s\S]*?removedSession\?\.project_id \?\? state\.currentProjectId[\s\S]*?false[\s\S]*?\)/);
  assert.match(storeSource, /removingActiveSession \? \{[\s\S]*?autoOpenProjectPicker: false[\s\S]*?currentProjectId: removedSession\?\.project_id \?\? current\.currentProjectId/);
  assert.doesNotMatch(sidebarSource, /removeSession\(deleteConfirm\.session\.id\);\s*if \(activeSessionId === deleteConfirm\.session\.id\) setActiveSession\(''\)/);
  assert.doesNotMatch(chatViewSource, /removeSession\(deleteTarget\.id\);\s*if \(activeSessionId === deleteTarget\.id\) setActiveSession\(''\)/);
});
