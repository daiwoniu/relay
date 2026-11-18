import assert from 'node:assert/strict';
import test from 'node:test';
import { qrHslToHex } from './qr-colors.ts';

test('palette generation reproduces primary colors, gray endpoints and wrapping hue', () => {
  assert.equal(qrHslToHex([0, 100, 50]), '#ff0000');
  assert.equal(qrHslToHex([120, 100, 50]), '#00ff00');
  assert.equal(qrHslToHex([240, 100, 50]), '#0000ff');
  assert.equal(qrHslToHex([360, 100, 50]), '#ff0000');
  assert.equal(qrHslToHex([-120, 100, 50]), '#0000ff');
  assert.equal(qrHslToHex([123, 80, 0]), '#000000');
  assert.equal(qrHslToHex([123, 80, 100]), '#ffffff');
  assert.equal(qrHslToHex([123, 0, 50]), '#808080');
});
