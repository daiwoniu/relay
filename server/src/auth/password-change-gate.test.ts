import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { isPasswordChangeAllowedRequest } from './middleware.js';

test('首次改密账号仅可读取本人、改密和退出', () => {
  const pending = { mustChangePassword: true };
  assert.equal(isPasswordChangeAllowedRequest(pending, '/api/auth/me'), true);
  assert.equal(isPasswordChangeAllowedRequest(pending, '/api/auth/change-password'), true);
  assert.equal(isPasswordChangeAllowedRequest(pending, '/api/auth/logout'), true);
  assert.equal(isPasswordChangeAllowedRequest(pending, '/api/projects'), false);
  assert.equal(isPasswordChangeAllowedRequest({ mustChangePassword: false }, '/api/projects'), true);
});

test('WebSocket 建连同样拒绝待首次改密账号', () => {
  const source = fs.readFileSync(new URL('../ws/frontend.ts', import.meta.url), 'utf8');
  assert.match(source, /authSession\.user\.mustChangePassword/);
  assert.match(source, /ws\.close\(1008, '首次登录必须先修改密码'\)/);
});
