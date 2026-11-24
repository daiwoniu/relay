import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('全部范围把整理策略传给项目和会话列表', () => {
  const sidebar = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
  assert.match(sidebar, /const dragDisabled = !accountInteractionPolicy\.canOrganize/);
  assert.match(sidebar, /canOrganize=\{accountInteractionPolicy\.canOrganize\}/);
  assert.match(sidebar, /const showResourceOwner = accountScope === 'all' && !ownerFilterId/);
  assert.match(sidebar, /showOwner=\{showResourceOwner\}/);
  assert.match(sidebar, /onPin: menuInteractionPolicy\.canOrganize \?/);
  assert.match(sidebar, /renameLabel: menuInteractionPolicy\.renameLabel/);
});

test('全部范围共享到聊天标题菜单并隐藏置顶、标明跨账号重命名', () => {
  const sidebar = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
  const chatView = readFileSync(new URL('../chat/ChatView.tsx', import.meta.url), 'utf8');
  const store = readFileSync(new URL('../../stores/chat.ts', import.meta.url), 'utf8');
  assert.match(sidebar, /sidebarAccountScope: accountScope/);
  assert.match(chatView, /sidebarAccountScope/);
  assert.match(chatView, /onPin: titleMenuInteractionPolicy\.canOrganize \? handleTitlePin : undefined/);
  assert.match(chatView, /if \(!currentSession \|\| !titleMenuInteractionPolicy\.canOrganize\) return/);
  assert.match(chatView, /renameLabel: titleMenuInteractionPolicy\.renameLabel/);
  assert.match(store, /sidebarAccountScope: 'mine'/);
  assert.match(store, /setSidebarAccountScope: \(scope\) => set\(\{ sidebarAccountScope: scope \}\)/);
});

test('项目和会话标题按策略显示所属用户标志并隐藏行内置顶与快捷新会话', () => {
  const navigation = readFileSync(new URL('./SidebarNavigationItems.tsx', import.meta.url), 'utf8');
  assert.match(navigation, /showOwner && <ResourceOwnerBadge owner=\{project\.owner\}/);
  assert.match(navigation, /showOwner && <ResourceOwnerBadge owner=\{session\.owner\}/);
  assert.match(navigation, /\{canOrganize && <span className="hidden lg:inline-flex">/);
  assert.match(navigation, /const canCreateSession = canCreateSidebarProjectSession\(project, canOrganize\)/);
  assert.match(navigation, /\{canCreateSession && <span className="inline-flex">[\s\S]*?label="新会话"/);
  assert.match(navigation, /showEmptyState && \(sessionCount === 0 && canCreateSession \? \([\s\S]*?onClick=\{createSession\}/);
});

test('禁用拖排时不向仍可点击的项目和会话按钮注入 aria-disabled', () => {
  const navigation = readFileSync(new URL('./SidebarNavigationItems.tsx', import.meta.url), 'utf8');
  assert.equal((navigation.match(/\.\.\.\(dragDisabled \? \{\} : attributes\)/g) ?? []).length, 2);
  assert.equal((navigation.match(/\.\.\.\(dragDisabled \? \{\} : listeners\)/g) ?? []).length, 2);
  assert.doesNotMatch(navigation, /\n\s*\{\.\.\.attributes\}\n\s*\{\.\.\.listeners\}/);
});
