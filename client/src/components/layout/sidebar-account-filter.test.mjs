import assert from 'node:assert/strict';
import test from 'node:test';
import { getSidebarOwnerFilter, resolveSidebarOwnerId } from './sidebar-account-filter.ts';

const items = [{ id: 'a', owner: { id: 'user-a' } }, { id: 'b', owner: { id: 'user-b' } }];
test('管理员侧栏默认只看自己，并可查看全部或指定成员', () => {
  assert.deepEqual(items.filter(getSidebarOwnerFilter(resolveSidebarOwnerId('user-a', 'mine', null))).map((x) => x.id), ['a']);
  assert.deepEqual(items.filter(getSidebarOwnerFilter(resolveSidebarOwnerId('user-a', 'all', null))).map((x) => x.id), ['a', 'b']);
  assert.deepEqual(items.filter(getSidebarOwnerFilter(resolveSidebarOwnerId('user-a', 'all', 'user-b'))).map((x) => x.id), ['b']);
});
