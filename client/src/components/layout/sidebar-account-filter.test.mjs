import assert from 'node:assert/strict';
import test from 'node:test';
import { filterOwnedSidebarItems } from './sidebar-account-filter.ts';
import { hideEmptyProjectsInAllScope } from './session-project.ts';

const items = [{ id: 'a', owner: { id: 'user-a' } }, { id: 'b', owner: { id: 'user-b' } }];
test('管理员侧栏默认只看自己，并可查看全部或指定成员', () => {
  assert.deepEqual(filterOwnedSidebarItems(items, 'user-a', 'mine', null).map((x) => x.id), ['a']);
  assert.deepEqual(filterOwnedSidebarItems(items, 'user-a', 'all', null).map((x) => x.id), ['a', 'b']);
  assert.deepEqual(filterOwnedSidebarItems(items, 'user-a', 'all', 'user-b').map((x) => x.id), ['b']);
});

const projects = [
  { id: 'p-system', is_system: 1 },
  { id: 'p-empty' },
  { id: 'p-active' },
];
test('全部用户视图隐藏没有会话的项目，显式归属优先于默认项目回退', () => {
  const sessions = [
    { id: 's1', project_id: 'p-active' },
    { id: 's2', project_id: null },
  ];
  assert.deepEqual(hideEmptyProjectsInAllScope(projects, sessions).map((p) => p.id), ['p-system', 'p-active']);
});

test('空项目视图按会话实际归属过滤，系统默认项目无会话时也隐藏', () => {
  const sessions = [{ id: 's1', project_id: 'p-active' }];
  assert.deepEqual(hideEmptyProjectsInAllScope(projects, sessions).map((p) => p.id), ['p-active']);
});
