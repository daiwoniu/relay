import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, verifyPassword } from './password.js';
import { ACCEPTANCE_SESSION_TTL_MS, SESSION_TTL_MS, createSessionToken, getSessionExpiry, hashSessionToken } from './session.js';

test('密码使用带随机盐的 scrypt 哈希并能安全验证', () => {
  const first = hashPassword('admin');
  const second = hashPassword('admin');

  assert.notEqual(first, second);
  assert.equal(first.includes('admin'), false);
  assert.equal(verifyPassword('admin', first), true);
  assert.equal(verifyPassword('wrong', first), false);
  assert.equal(verifyPassword('admin', 'invalid-hash'), false);
});

test('登录会话使用随机令牌且数据库只需保存稳定哈希', () => {
  const first = createSessionToken();
  const second = createSessionToken();

  assert.notEqual(first.token, second.token);
  assert.equal(first.tokenHash, hashSessionToken(first.token));
  assert.match(first.tokenHash, /^[a-f0-9]{64}$/);
});

test('登录状态默认保持三十天', () => {
  const now = Date.UTC(2026, 7, 4);
  assert.equal(SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(getSessionExpiry(now), now + SESSION_TTL_MS);
});

test('无头验收会话固定为一百八十天且拒绝任意期限', () => {
  const now = Date.UTC(2026, 7, 4);
  assert.equal(ACCEPTANCE_SESSION_TTL_MS, 180 * 24 * 60 * 60 * 1000);
  assert.equal(getSessionExpiry(now, ACCEPTANCE_SESSION_TTL_MS), now + ACCEPTANCE_SESSION_TTL_MS);
  assert.throws(() => getSessionExpiry(now, 181 * 24 * 60 * 60 * 1000), /会话有效期/);
  assert.throws(() => getSessionExpiry(now, 31 * 24 * 60 * 60 * 1000), /会话有效期/);
});
