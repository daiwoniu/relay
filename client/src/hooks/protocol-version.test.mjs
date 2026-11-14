import assert from 'node:assert/strict';
import test from 'node:test';
import { getProtocolCompatibility } from './protocol-version.ts';

test('协议版本仅在与客户端版本一致时兼容', () => {
  assert.deepEqual(getProtocolCompatibility(2, 2), { compatible: true, message: null, mismatch: null });
  assert.equal(getProtocolCompatibility(1, 2).compatible, false);
  assert.match(getProtocolCompatibility(1, 2).message, /前后端协议版本不兼容/);
  assert.deepEqual(getProtocolCompatibility(1, 2).mismatch, { clientVersion: 2, serverVersion: 1 });
  assert.deepEqual(getProtocolCompatibility(undefined, 2).mismatch, { clientVersion: 2, serverVersion: null });
});
