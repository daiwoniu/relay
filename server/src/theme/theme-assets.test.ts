import assert from 'node:assert/strict';
import test from 'node:test';
import { readWebPDimensions, validateThemeBackgroundUpload } from './theme-assets.js';

function vp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(48);
  bytes.set(Buffer.from('RIFF'), 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set(Buffer.from('WEBP'), 8);
  bytes.set(Buffer.from('VP8X'), 12);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 255, (w >> 8) & 255, (w >> 16) & 255], 24);
  bytes.set([h & 255, (h >> 8) & 255, (h >> 16) & 255], 27);
  bytes.set(Buffer.from('VP8 '), 30);
  new DataView(bytes.buffer).setUint32(34, 10, true);
  bytes.set([0, 0, 0, 0x9d, 0x01, 0x2a, width & 255, (width >> 8) & 0x3f, height & 255, (height >> 8) & 0x3f], 38);
  return bytes;
}

function vp8l(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(26);
  bytes.set(Buffer.from('RIFF'), 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set(Buffer.from('WEBP'), 8);
  bytes.set(Buffer.from('VP8L'), 12);
  new DataView(bytes.buffer).setUint32(16, 5, true);
  bytes[20] = 0x2f;
  const w = width - 1;
  const h = height - 1;
  bytes[21] = w & 255;
  bytes[22] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
  bytes[23] = (h >> 2) & 255;
  bytes[24] = (h >> 10) & 0x0f;
  return bytes;
}

test('读取 WebP VP8X 画布尺寸', () => {
  assert.deepEqual(readWebPDimensions(vp8x(2560, 1440)), { width: 2560, height: 1440 });
  assert.deepEqual(readWebPDimensions(vp8l(800, 600)), { width: 800, height: 600 });
});

test('分别限制桌面和移动背景最长边', () => {
  assert.equal(validateThemeBackgroundUpload('desktop', vp8x(2560, 1440)).ok, true);
  assert.equal(validateThemeBackgroundUpload('mobile', vp8x(1440, 1920)).ok, true);
  assert.deepEqual(validateThemeBackgroundUpload('mobile', vp8x(1921, 1080)), {
    ok: false,
    error: '移动背景最长边不能超过 1920px',
  });
});

test('拒绝伪造格式和超过大小限制的背景', () => {
  assert.equal(validateThemeBackgroundUpload('desktop', new Uint8Array([1, 2, 3])).ok, false);
  assert.equal(validateThemeBackgroundUpload('desktop', new Uint8Array(4 * 1024 * 1024 + 1)).ok, false);
  const invalidRiffSize = vp8x(800, 600);
  new DataView(invalidRiffSize.buffer).setUint32(4, 1, true);
  assert.equal(validateThemeBackgroundUpload('desktop', invalidRiffSize).ok, false);
  const invalidChunkSize = vp8x(800, 600);
  new DataView(invalidChunkSize.buffer).setUint32(16, 100, true);
  assert.equal(validateThemeBackgroundUpload('desktop', invalidChunkSize).ok, false);
});
