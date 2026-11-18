import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_QR_PREFERENCES, readQrPreferences, serializeQrPreferences } from './qr-preferences.ts';
import { createQrSvg } from './qr-code.ts';

test('style round-trip remembers colors, shape, preset icon and output size', () => {
  const style = { foreground: '#14532d', background: '#f0fdf4', shape: 'dots', center: 'sticker', stickerId: 'cake', pngSize: 4096 };
  assert.deepEqual(readQrPreferences(serializeQrPreferences(style)), style);
});

test('storage excludes QR content, center text, uploaded images and unknown fields', () => {
  for (const center of ['image', 'text']) {
    const saved = serializeQrPreferences({ ...DEFAULT_QR_PREFERENCES, center, text: 'private link', centerText: '姓名', centerImage: 'data:private', unknown: 'secret' });
    assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), ['version', 'foreground', 'background', 'shape', 'center', 'stickerId', 'pngSize'].sort());
    assert.doesNotMatch(saved, /private|姓名|secret/);
    assert.equal(readQrPreferences(saved).center, 'none');
  }
});

test('invalid, future or removed values fall back safely', () => {
  for (const raw of [null, '', '{bad', '[]', 'null', '{"version":2}']) assert.deepEqual(readQrPreferences(raw), DEFAULT_QR_PREFERENCES);
  assert.deepEqual(readQrPreferences(JSON.stringify({ version: 1, foreground: '<svg>', background: 'red', shape: 'unknown', center: 'unknown', stickerId: 'removed', pngSize: -1 })), DEFAULT_QR_PREFERENCES);
});

test('chosen low-contrast, identical and inverted colors survive storage unchanged', () => {
  for (const [foreground, background] of [['#ffffff', '#ffffff'], ['#ffffff', '#000000'], ['#cccccc', '#ffffff']]) {
    const restored = readQrPreferences(JSON.stringify({ version: 1, foreground, background, shape: 'dots', center: 'sticker', stickerId: 'football' }));
    assert.equal(restored.foreground, foreground);
    assert.equal(restored.background, background);
    assert.deepEqual(readQrPreferences(serializeQrPreferences(restored)), restored);
    assert.equal(restored.shape, 'dots');
    assert.equal(restored.stickerId, 'football');
    assert.ok(createQrSvg('Relay 二维码样例', { ...restored, centerSticker: restored.stickerId }).startsWith('<svg'));
  }
});

test('style remains valid independently of a payload that exceeds center correction capacity', () => {
  const style = { ...DEFAULT_QR_PREFERENCES, foreground: '#14532d', background: '#f0fdf4', center: 'sticker', stickerId: 'rocket' };
  assert.throws(() => createQrSvg('x'.repeat(1500), { ...style, centerSticker: style.stickerId }), /容量不足/);
  const restored = readQrPreferences(serializeQrPreferences({ ...style, text: 'x'.repeat(1500) }));
  assert.deepEqual(restored, style);
  assert.ok(createQrSvg('Relay 二维码样例', { ...restored, centerSticker: restored.stickerId }).startsWith('<svg'));
});
