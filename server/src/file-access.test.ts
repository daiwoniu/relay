import assert from 'node:assert/strict';
import test from 'node:test';
import { FileAccessGrants } from './file-access.js';

test('强制访问令牌只允许授权的单个文件', () => {
  const grants = new FileAccessGrants(1000);
  const token = grants.grant('D:\\project\\allowed.txt', 100);
  assert.equal(grants.allows('D:\\project\\allowed.txt', token, 200), true);
  assert.equal(grants.allows('D:\\project\\other.txt', token, 200), false);
});

test('强制访问令牌撤销或过期后失效', () => {
  const grants = new FileAccessGrants(1000);
  const revoked = grants.grant('D:\\project\\file.txt', 100);
  grants.revoke(revoked);
  assert.equal(grants.allows('D:\\project\\file.txt', revoked, 200), false);

  const expired = grants.grant('D:\\project\\file.txt', 100);
  assert.equal(grants.allows('D:\\project\\file.txt', expired, 1100), false);
});

test('账号文件令牌不能被其他账号读取、撤销或消费', () => {
  const grants = new FileAccessGrants(1000);
  const token = grants.grant('D:\\project\\file.txt', 'member-a', 100);

  assert.equal(grants.allows('D:\\project\\file.txt', token, 'member-b', 200), false);
  grants.revoke(token, 'member-b');
  assert.equal(grants.allows('D:\\project\\file.txt', token, 'member-a', 200), true);
  assert.equal(grants.consume('D:\\project\\file.txt', token, 'member-b', 200), false);
  assert.equal(grants.consume('D:\\project\\file.txt', token, 'member-a', 200), true);
  assert.equal(grants.allows('D:\\project\\file.txt', token, 'member-a', 200), false);
});
