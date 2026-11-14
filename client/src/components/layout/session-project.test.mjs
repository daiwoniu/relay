import assert from 'node:assert/strict';
import test from 'node:test';
import { filterSelectableProjects, resolveDefaultProjectId, resolveSessionProjectId, hideEmptyProjectsInAllScope, readShowAllProjectsPreference, storeShowAllProjectsPreference } from './session-project.ts';

const projects = [
  { id: 'default-project', is_system: 1 },
  { id: 'normal-project', is_system: 0 },
];

test('会话保留有效项目归属', () => {
  assert.equal(resolveSessionProjectId({ project_id: 'normal-project' }, projects), 'normal-project');
});

test('顶部新会话入口解析系统默认项目', () => {
  assert.equal(resolveDefaultProjectId(projects), 'default-project');
  assert.equal(resolveDefaultProjectId([{ id: 'normal-project', is_system: 0 }]), null);
});

test('账号个人默认项目优先于 Relay 系统项目', () => {
  assert.equal(resolveDefaultProjectId(projects, 'normal-project'), 'normal-project');
  assert.equal(resolveDefaultProjectId(projects, 'missing-project'), 'default-project');
});

test('无项目会话回退到默认项目', () => {
  assert.equal(resolveSessionProjectId({ project_id: null }, projects), 'default-project');
});

test('新会话项目列表包含当前账号项目和可创建会话的授权项目', () => {
  const selectable = filterSelectableProjects([
    { id: 'mine-system', owner: { id: 'user-a' }, access_role: 'owner' },
    { id: 'mine-normal', owner: { id: 'user-a' } },
    { id: 'shared-collab', owner: { id: 'user-b' }, access_role: 'collaborator' },
    { id: 'shared-manager', owner: { id: 'user-b' }, access_role: 'manager' },
    { id: 'shared-viewer', owner: { id: 'user-b' }, access_role: 'viewer' },
    { id: 'other-system', owner: { id: 'user-b' } },
    { id: 'legacy-project' },
  ], 'user-a');

  assert.deepEqual(selectable.map((project) => project.id), [
    'mine-system',
    'mine-normal',
    'shared-collab',
    'shared-manager',
  ]);
  assert.deepEqual(filterSelectableProjects(projects, null), []);
});

test('项目已不存在的会话回退到默认项目', () => {
  assert.equal(resolveSessionProjectId({ project_id: 'deleted-project' }, projects), 'default-project');
});

function createMemoryStorage(initial = new Map()) {
  return {
    getItem: (key) => initial.has(key) ? initial.get(key) : null,
    setItem: (key, value) => initial.set(key, value),
  };
}

test('全部用户视图隐藏没有会话的项目，默认项目回退按完整列表解析', () => {
  const scoped = [
    { id: 'p-system', is_system: 1 },
    { id: 'p-empty' },
    { id: 'p-active' },
  ];
  const sessions = [
    { id: 's1', project_id: 'p-active' },
    { id: 's2', project_id: null },
  ];
  // s2 无归属回退到 p-system，所以 p-system 有会话；p-empty 被隐藏
  assert.deepEqual(hideEmptyProjectsInAllScope(scoped, sessions).map((p) => p.id), ['p-system', 'p-active']);
  assert.deepEqual(hideEmptyProjectsInAllScope(scoped, [{ id: 's1', project_id: 'p-active' }]).map((p) => p.id), ['p-active']);
});

test('显示全部项目偏好默认关闭并按 localStorage 持久化', () => {
  assert.equal(readShowAllProjectsPreference(null), false);
  assert.equal(readShowAllProjectsPreference(createMemoryStorage()), false);
  const storage = createMemoryStorage();
  storeShowAllProjectsPreference(true, storage);
  assert.equal(readShowAllProjectsPreference(storage), true);
  storeShowAllProjectsPreference(false, storage);
  assert.equal(readShowAllProjectsPreference(storage), false);
});
