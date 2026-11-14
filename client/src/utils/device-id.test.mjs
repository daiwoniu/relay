import assert from 'node:assert/strict';
import test from 'node:test';

test('设备标识在存储可用时持久稳定且写入本地存储', async () => {
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const { getDeviceId } = await import('./device-id.ts');
  const first = getDeviceId();
  assert.ok(typeof first === 'string' && first.length > 0 && first.length <= 128);
  assert.equal(getDeviceId(), first);
  assert.equal(values.get('relay:device-id'), first);
});

test('存储不可用时返回空串且不抛异常', async () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('storage unavailable'); },
  });
  const { getDeviceId } = await import('./device-id.ts?unavailable');
  assert.equal(getDeviceId(), '');
});
