import assert from 'node:assert/strict';
import test from 'node:test';
import { canCreateSidebarProjectSession, getSidebarAccountInteractionPolicy } from './sidebar-account-interactions.ts';

const member = { id: 'member-a', displayName: '成员 A' };

test('我的范围保留个人整理动作且不重复显示所属用户', () => {
  assert.deepEqual(getSidebarAccountInteractionPolicy('mine', 'admin', member), {
    showOwner: false,
    canOrganize: true,
    renameLabel: '重命名',
  });
});

test('全部范围禁用排序和置顶并显示所属用户', () => {
  assert.deepEqual(getSidebarAccountInteractionPolicy('all', 'admin', { id: 'admin', displayName: '祥哥' }), {
    showOwner: true,
    canOrganize: false,
    renameLabel: '重命名',
  });
});

test('全部范围重命名他人资源时在入口标明所属用户', () => {
  assert.equal(getSidebarAccountInteractionPolicy('all', 'admin', member).renameLabel, '重命名 · 成员 A');
});

test('侧栏创建入口禁止只读项目和全部用户视图，保留可协作和旧项目', () => {
  assert.equal(canCreateSidebarProjectSession({ access_role: 'viewer' }, true), false);
  assert.equal(canCreateSidebarProjectSession({ access_role: 'owner' }, false), false);
  assert.equal(canCreateSidebarProjectSession({ access_role: 'collaborator' }, true), true);
  assert.equal(canCreateSidebarProjectSession({}, true), true);
});
