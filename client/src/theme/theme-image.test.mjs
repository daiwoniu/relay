import assert from 'node:assert/strict';
import test from 'node:test';
import { fitImageWithin, MAX_THEME_SOURCE_BYTES, validateThemeImageFile } from './theme-image.ts';

test('图片未超过限制时保留原尺寸', () => {
  assert.deepEqual(fitImageWithin(1200, 800, 1920), { width: 1200, height: 800 });
});

test('横图和竖图按最长边等比缩放', () => {
  assert.deepEqual(fitImageWithin(4000, 2000, 2560), { width: 2560, height: 1280 });
  assert.deepEqual(fitImageWithin(2000, 4000, 1920), { width: 960, height: 1920 });
});

test('上传前拒绝错误格式、空文件和过大的原始背景', () => {
  assert.equal(validateThemeImageFile({ type: 'text/plain', size: 100 }), '背景仅支持 JPG、PNG 或 WebP');
  assert.equal(validateThemeImageFile({ type: 'image/png', size: 0 }), '请选择背景图片');
  assert.equal(validateThemeImageFile({ type: 'image/jpeg', size: MAX_THEME_SOURCE_BYTES + 1 }), '原始背景图片不能超过 20 MiB');
  assert.equal(validateThemeImageFile({ type: 'image/webp', size: 1024 }), null);
});
