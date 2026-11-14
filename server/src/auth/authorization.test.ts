import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canManageOwnedResource,
  requireOwnedResource,
  visibleOwnerUserId,
  type Actor,
} from './authorization.js';

const member: Actor = { userId: 'member-a', role: 'member' };
const admin: Actor = { userId: 'admin', role: 'admin' };

test('普通成员只管理自己的资源且管理员可管理全部资源', () => {
  assert.equal(canManageOwnedResource(member, 'member-a'), true);
  assert.equal(canManageOwnedResource(member, 'member-b'), false);
  assert.equal(canManageOwnedResource(admin, 'member-b'), true);
  assert.equal(visibleOwnerUserId(member), 'member-a');
  assert.equal(visibleOwnerUserId(admin), undefined);
});

test('缺失所有者或越权资源统一按不存在处理', () => {
  assert.equal(requireOwnedResource(member, { id: 'own', owner_user_id: 'member-a' }, '项目').id, 'own');
  assert.throws(() => requireOwnedResource(member, { id: 'other', owner_user_id: 'member-b' }, '项目'), /项目不存在/);
  assert.throws(() => requireOwnedResource(member, { id: 'legacy', owner_user_id: null }, '项目'), /项目不存在/);
  assert.equal(requireOwnedResource(admin, { id: 'other', owner_user_id: 'member-b' }, '项目').id, 'other');
});
