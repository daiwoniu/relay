import assert from 'node:assert/strict';
import test from 'node:test';
import { copyThemeProfile, createDefaultThemeSettings, getThemeDevice, getThemeProfile, getUnusedPendingThemeAssetIds, legacyThemeCacheKey, readCachedThemeSettings, setLinkedThemeProfiles, setThemeProfile, themeCacheKey } from './theme-model.ts';

test('按 768px 断点选择桌面或移动主题', () => {
  assert.equal(getThemeDevice(767), 'mobile');
  assert.equal(getThemeDevice(768), 'desktop');
});

test('账号主题默认使用 v2 中性色与标准字号', () => {
  const settings = createDefaultThemeSettings();
  assert.equal(settings.version, 2);
  assert.equal(settings.colorStyle, 'neutral');
  assert.equal(settings.textScale, 'standard');
});

test('同步配置始终以桌面配置应用到两端', () => {
  const settings = createDefaultThemeSettings();
  const changed = setThemeProfile(settings, 'mobile', { ...settings.mobile, panelOpacity: 0.8 });
  assert.equal(changed.desktop.panelOpacity, 0.8);
  assert.deepEqual(getThemeProfile(changed, 'mobile'), changed.desktop);
});

test('解除同步后两端独立并支持单次复制', () => {
  const settings = setLinkedThemeProfiles(createDefaultThemeSettings(), false);
  const changed = setThemeProfile(settings, 'desktop', { ...settings.desktop, backgroundKind: 'preset', backgroundValue: 'mist' });
  assert.equal(changed.mobile.backgroundKind, 'none');
  assert.deepEqual(copyThemeProfile(changed, 'desktop').mobile, changed.desktop);
});

test('保存后只清理未被桌面或移动配置引用的本轮上传资源', () => {
  const settings = setLinkedThemeProfiles(createDefaultThemeSettings(), false);
  const desktop = setThemeProfile(settings, 'desktop', { ...settings.desktop, backgroundKind: 'asset', backgroundValue: 'asset-desktop' });
  const both = setThemeProfile(desktop, 'mobile', { ...desktop.mobile, backgroundKind: 'asset', backgroundValue: 'asset-mobile' });
  assert.deepEqual(
    getUnusedPendingThemeAssetIds(['asset-desktop', 'asset-replaced', 'asset-mobile'], both),
    ['asset-replaced'],
  );
});

test('损坏或越界的账号主题缓存不会进入运行时', () => {
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const valid = createDefaultThemeSettings();
  values.set(themeCacheKey('user-1'), JSON.stringify(valid));
  assert.deepEqual(readCachedThemeSettings('user-1'), valid);
  values.set(themeCacheKey('user-1'), JSON.stringify({ ...valid, desktop: { ...valid.desktop, panelOpacity: -1 } }));
  assert.equal(readCachedThemeSettings('user-1'), null);
});

test('旧版账号主题缓存无损迁移到 v2 并清理旧 key', () => {
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const current = createDefaultThemeSettings('dark');
  const { colorStyle: _colorStyle, textScale: _textScale, ...legacy } = current;
  values.set(legacyThemeCacheKey('user-1'), JSON.stringify({ ...legacy, version: 1 }));
  assert.deepEqual(readCachedThemeSettings('user-1'), current);
  assert.equal(values.has(legacyThemeCacheKey('user-1')), false);
  assert.equal(JSON.parse(values.get(themeCacheKey('user-1'))).version, 2);
});
