import assert from 'node:assert/strict';
import test from 'node:test';
import { createThemeBootstrap, readThemeBootstrap, resetThemeBootstrap, resetThemeBootstrapFromLocalPreference, THEME_BOOTSTRAP_KEY, writeThemeBootstrap } from './theme-bootstrap.ts';

function memoryStorage(initial = new Map()) {
  return {
    values: initial,
    getItem(key) { return this.values.get(key) ?? null; },
    setItem(key, value) { this.values.set(key, value); },
  };
}

test('首屏镜像只保存三个公开外观维度', () => {
  const mirror = createThemeBootstrap({ basePreference: 'dark', colorStyle: 'aurora', textScale: 'large' });
  assert.deepEqual(mirror, { version: 2, basePreference: 'dark', colorStyle: 'aurora', textScale: 'large' });
  assert.equal(JSON.stringify(mirror).includes('background'), false);
});

test('首屏镜像安全读取并拒绝损坏或多余字段', () => {
  const storage = memoryStorage();
  writeThemeBootstrap({ basePreference: 'light', colorStyle: 'aurora', textScale: 'compact' }, storage);
  assert.deepEqual(readThemeBootstrap(storage), { version: 2, basePreference: 'light', colorStyle: 'aurora', textScale: 'compact' });
  storage.values.set(THEME_BOOTSTRAP_KEY, '{bad');
  assert.equal(readThemeBootstrap(storage), null);
  storage.values.set(THEME_BOOTSTRAP_KEY, JSON.stringify({ version: 2, basePreference: 'dark', colorStyle: 'aurora', textScale: 'large', assetId: 'private' }));
  assert.equal(readThemeBootstrap(storage), null);
});

test('退出账号将镜像恢复为本地明暗和中性标准外观', () => {
  const storage = memoryStorage();
  resetThemeBootstrap('dark', storage);
  assert.deepEqual(readThemeBootstrap(storage), { version: 2, basePreference: 'dark', colorStyle: 'neutral', textScale: 'standard' });
});

test('退出链路从设备明暗偏好生成安全镜像', () => {
  const storage = memoryStorage(new Map([['relay_theme', 'light']]));
  resetThemeBootstrapFromLocalPreference(storage);
  assert.deepEqual(readThemeBootstrap(storage), { version: 2, basePreference: 'light', colorStyle: 'neutral', textScale: 'standard' });
});
