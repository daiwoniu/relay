import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sidebar = fs.readFileSync(new URL('Sidebar.tsx', import.meta.url), 'utf8');

test('Sidebar 将导航展示职责委托给独立模块', () => {
  assert.match(sidebar, /from '\.\/SidebarNavigationItems'/);
  assert.doesNotMatch(sidebar, /function ProjectBlock\(/);
  assert.doesNotMatch(sidebar, /function SessionRow\(/);
});

test('Sidebar 主组件保持在 1310 行以内', () => {
  assert.ok(sidebar.trimEnd().split(/\r?\n/).length <= 1310);
});
