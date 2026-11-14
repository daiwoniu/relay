import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySidebarOrder,
  getDefaultSidebarItems,
  moveSidebarItems,
  resolveSidebarItems,
} from './sidebar-order.ts';

const project = (id, overrides = {}) => ({ id, name: id, path: id, created_at: 1, updated_at: 1, pinned: 0, pinned_at: null, is_system: 0, ...overrides });
const session = (id, projectId, overrides = {}) => ({ id, title: id, created_at: 1, updated_at: 1, pinned: 0, pinned_at: null, project_id: projectId, codex_archived: false, status: 'idle', ...overrides });
const keys = (items) => items.map((item) => `${item.type}:${item.id}`);

test('侧栏排序客户端：无服务端顺序时使用稳定默认规则', () => {
  const projects = [project('default', { is_system: 1, created_at: 3 }), project('old'), project('new', { created_at: 2 })];
  assert.deepEqual(keys(getDefaultSidebarItems('projects', projects, [])), ['project:new', 'project:old', 'project:default']);
});

test('侧栏排序客户端：自定义顺序过滤失效项并把新成员置顶', () => {
  const projects = [project('a'), project('b', { created_at: 2 }), project('new', { created_at: 3 })];
  const resolved = resolveSidebarItems('projects', projects, [], {
    scope: 'projects',
    custom: true,
    items: [{ type: 'project', id: 'a' }, { type: 'project', id: 'removed' }, { type: 'project', id: 'b' }],
  });
  assert.deepEqual(keys(resolved), ['project:new', 'project:a', 'project:b']);
});

test('侧栏排序客户端：置顶项目与独立会话可以混排并投影回实体', () => {
  const projects = [project('p', { pinned: 1, pinned_at: 2 }), project('normal')];
  const sessions = [session('s', 'normal', { pinned: 1, pinned_at: 3 })];
  const order = getDefaultSidebarItems('pinned', projects, sessions);
  assert.deepEqual(keys(order), ['session:s', 'project:p']);
  assert.deepEqual(applySidebarOrder(projects, order, 'project').map((item) => item.id), ['p']);
  assert.deepEqual(applySidebarOrder(sessions, order, 'session').map((item) => item.id), ['s']);
});

test('侧栏排序客户端：乐观移动支持目标之前和末尾', () => {
  const initial = [{ type: 'session', id: 'a' }, { type: 'session', id: 'b' }, { type: 'session', id: 'c' }];
  const moved = moveSidebarItems(initial, initial[2], initial[0]);
  assert.deepEqual(keys(moved), ['session:c', 'session:a', 'session:b']);
  assert.deepEqual(keys(moveSidebarItems(moved, moved[0], null)), ['session:a', 'session:b', 'session:c']);
});
