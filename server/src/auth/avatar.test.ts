import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_AVATAR_BYTES, validateAvatarUpload } from './avatar.js';

test('头像校验接受 JPEG、PNG 与 WebP 魔数', () => {
  assert.equal(validateAvatarUpload('image/jpeg', Uint8Array.from([0xff, 0xd8, 0xff, 0x00])).ok, true);
  assert.equal(validateAvatarUpload('image/png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).ok, true);
  assert.equal(validateAvatarUpload('image/webp', Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])).ok, true);
});

test('头像校验拒绝伪造格式、空文件和超大文件', () => {
  assert.equal(validateAvatarUpload('image/png', Uint8Array.from([0xff, 0xd8, 0xff])).ok, false);
  assert.equal(validateAvatarUpload('image/gif', Uint8Array.from([0x47, 0x49, 0x46])).ok, false);
  assert.equal(validateAvatarUpload('image/png', new Uint8Array()).ok, false);
  assert.equal(validateAvatarUpload('image/png', new Uint8Array(MAX_AVATAR_BYTES + 1)).ok, false);
});
