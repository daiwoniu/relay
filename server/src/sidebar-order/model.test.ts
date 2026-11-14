import assert from 'node:assert/strict';
import test from 'node:test';
import type { SidebarOrderItemDto } from '../contracts/index.js';
import {
  getDefaultSidebarOrder,
  moveSidebarOrderItem,
  reconcileSidebarOrder,
  type SidebarOrderProjectSource,
  type SidebarOrderSessionSource,
} from './model.js';

function project(overrides: Partial<SidebarOrderProjectSource> & Pick<SidebarOrderProjectSource, 'id'>): SidebarOrderProjectSource {
  return { created_at: 0, updated_at: 0, pinned: 0, pinned_at: null, is_system: 0, ...overrides };
}

function session(overrides: Partial<SidebarOrderSessionSource> & Pick<SidebarOrderSessionSource, 'id'>): SidebarOrderSessionSource {
  return { created_at: 0, updated_at: 0, pinned: 0, pinned_at: null, archived: 0, project_id: null, ...overrides };
}

const keys = (items: SidebarOrderItemDto[]) => items.map((item) => `${item.type}:${item.id}`);

test('侧栏排序：普通项目默认项目置底且其他项目按创建时间倒序', () => {
  const items = getDefaultSidebarOrder('projects', [
    project({ id: 'default', created_at: 100, is_system: 1 }),
    project({ id: 'older', created_at: 10 }),
    project({ id: 'newer', created_at: 20 }),
    project({ id: 'pinned', created_at: 30, pinned: 1, pinned_at: 50 }),
  ], []);
  assert.deepEqual(keys(items), ['project:newer', 'project:older', 'project:default']);
});

test('侧栏排序：置顶项目与独立置顶会话按置顶时间混排且默认项目置底', () => {
  const projects = [
    project({ id: 'default', pinned: 1, pinned_at: 100, is_system: 1 }),
    project({ id: 'normal', pinned: 0 }),
    project({ id: 'pinned-project', pinned: 1, pinned_at: 40 }),
  ];
  const sessions = [
    session({ id: 'standalone', project_id: 'normal', pinned: 1, pinned_at: 60 }),
    session({ id: 'nested', project_id: 'pinned-project', pinned: 1, pinned_at: 80 }),
  ];
  assert.deepEqual(keys(getDefaultSidebarOrder('pinned', projects, sessions)), [
    'session:standalone',
    'project:pinned-project',
    'project:default',
  ]);
});

test('侧栏排序：项目 scope 在普通项目排除独立置顶会话，在置顶项目保留全部会话', () => {
  const projects = [project({ id: 'normal' }), project({ id: 'pinned', pinned: 1, pinned_at: 1 })];
  const sessions = [
    session({ id: 'normal-new', project_id: 'normal', created_at: 30 }),
    session({ id: 'normal-pinned', project_id: 'normal', created_at: 40, pinned: 1, pinned_at: 50 }),
    session({ id: 'pinned-new', project_id: 'pinned', created_at: 20 }),
    session({ id: 'pinned-session', project_id: 'pinned', created_at: 10, pinned: 1, pinned_at: 60 }),
  ];
  assert.deepEqual(keys(getDefaultSidebarOrder('project:normal', projects, sessions)), ['session:normal-new']);
  assert.deepEqual(keys(getDefaultSidebarOrder('project:pinned', projects, sessions)), ['session:pinned-new', 'session:pinned-session']);
});

test('侧栏排序：自定义顺序移除失效项并把新成员插入顶部', () => {
  const defaults: SidebarOrderItemDto[] = [
    { type: 'project', id: 'new' },
    { type: 'project', id: 'kept-b' },
    { type: 'project', id: 'kept-a' },
  ];
  const stored: SidebarOrderItemDto[] = [
    { type: 'project', id: 'kept-a' },
    { type: 'project', id: 'removed' },
    { type: 'project', id: 'kept-b' },
  ];
  assert.deepEqual(keys(reconcileSidebarOrder(defaults, stored)), [
    'project:new',
    'project:kept-a',
    'project:kept-b',
  ]);
});

test('侧栏排序：邻居式移动支持插入目标之前和移动到末尾', () => {
  const initial: SidebarOrderItemDto[] = [
    { type: 'session', id: 'a' },
    { type: 'session', id: 'b' },
    { type: 'session', id: 'c' },
  ];
  const beforeA = moveSidebarOrderItem(initial, { type: 'session', id: 'c' }, { type: 'session', id: 'a' });
  assert.deepEqual(keys(beforeA), ['session:c', 'session:a', 'session:b']);
  assert.deepEqual(keys(moveSidebarOrderItem(beforeA, { type: 'session', id: 'c' }, null)), ['session:a', 'session:b', 'session:c']);
});

test('侧栏排序：跨范围的拖动项或邻居被拒绝', () => {
  const initial: SidebarOrderItemDto[] = [{ type: 'project', id: 'a' }];
  assert.throws(() => moveSidebarOrderItem(initial, { type: 'project', id: 'missing' }, null), /拖动项/);
  assert.throws(() => moveSidebarOrderItem(initial, { type: 'project', id: 'a' }, { type: 'project', id: 'missing' }), /目标邻居/);
});
