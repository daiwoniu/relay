import assert from 'node:assert/strict';
import test from 'node:test';
import { fitImageWithin } from './image-preview.ts';

test('大图按最长边缩放到 2048 像素', () => {
  assert.deepEqual(fitImageWithin(4096, 2160), { width: 2048, height: 1080 });
  assert.deepEqual(fitImageWithin(2160, 4096), { width: 1080, height: 2048 });
});

test('小图保持原始尺寸', () => {
  assert.deepEqual(fitImageWithin(1280, 720), { width: 1280, height: 720 });
});
