import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('项目行始终在更多菜单左侧显示新会话按钮', () => {
  const navigationItems = fs.readFileSync(new URL('SidebarNavigationItems.tsx', import.meta.url), 'utf8');
  const projectBlock = navigationItems.slice(navigationItems.indexOf('function ProjectBlock'));
  const newSessionButton = projectBlock.indexOf('label="新会话"');
  const moreButton = projectBlock.indexOf('label="更多"');
  const newSessionWrapper = projectBlock.lastIndexOf('<span className="inline-flex">', newSessionButton);

  assert.notEqual(newSessionButton, -1);
  assert.notEqual(moreButton, -1);
  assert.ok(newSessionButton < moreButton);
  assert.notEqual(newSessionWrapper, -1);
});

test('侧栏行右侧按钮和状态使用紧凑横向尺寸', () => {
  const sidebar = fs.readFileSync(new URL('Sidebar.tsx', import.meta.url), 'utf8');
  const navigationItems = fs.readFileSync(new URL('SidebarNavigationItems.tsx', import.meta.url), 'utf8');
  const source = `${sidebar}\n${navigationItems}`;

  assert.equal(source.match(/className="sidebar-resource-action-hitbox w-6 rounded-md"/g)?.length, 4);
  assert.match(navigationItems, /data-session-controls[\s\S]*?className="sidebar-session-row__tail ml-auto flex shrink-0 items-center gap-1"/);
  assert.match(navigationItems, /className="sidebar-resource-status inline-flex items-center justify-center"/);
});
