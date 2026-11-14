import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateAvatarCrop, validateNewPassword } from './avatar-editor.ts';

test('头像裁剪默认取图片中心正方形并支持缩放偏移', () => {
  assert.deepEqual(calculateAvatarCrop(800, 600, 1, 0, 0), { sx: 100, sy: 0, size: 600 });
  assert.deepEqual(calculateAvatarCrop(800, 600, 2, 1, -1), { sx: 500, sy: 0, size: 300 });
});

test('头像裁剪限制异常缩放和越界偏移', () => {
  assert.deepEqual(calculateAvatarCrop(400, 800, 99, -9, 9), { sx: 0, sy: 666.6666666666666, size: 133.33333333333334 });
});

test('新密码校验长度与两次输入一致性', () => {
  assert.equal(validateNewPassword('12345', '12345'), '新密码至少需要 6 个字符');
  assert.equal(validateNewPassword('123456', '654321'), '两次输入的新密码不一致');
  assert.equal(validateNewPassword('123456', '123456'), null);
  assert.equal(validateNewPassword('x'.repeat(50), 'x'.repeat(50)), null);
  assert.equal(validateNewPassword('x'.repeat(51), 'x'.repeat(51)), '新密码不能超过 50 个字符');
});
