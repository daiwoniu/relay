import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const component = readFileSync(new URL('./ProjectMembersDialog.tsx', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../layout/Sidebar.tsx', import.meta.url), 'utf8');

test('管理授权按账号单独设置全部会话可见性', () => {
  assert.match(component, /管理授权/);
  assert.match(component, /可查看全部会话/);
  assert.match(component, /changeViewSessions/);
  assert.match(component, /setProjectMember\(project.id, userId, current.role, next \? 1 : 0\)/);
  assert.match(component, /setProjectMember\(project.id, selected, role, canViewSessions \? 1 : 0\)/);
  assert.doesNotMatch(component, /members_can_view_sessions/);
  assert.doesNotMatch(component, /成员可查看全部会话/);
  assert.match(sidebar, /user\?\.role === 'admin'\) \? \[\{ id: 'project-members', label: '管理授权'/);
  assert.doesNotMatch(sidebar, /access_role === 'owner' \|\| menuProject\.access_role === 'manager'/);
});