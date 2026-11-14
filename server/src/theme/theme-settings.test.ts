import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDefaultThemeSettings,
  parseThemeSettings,
  projectThemeSettingsV1,
  readStoredThemeSettings,
  themeSettingsReferencesAsset,
} from './theme-settings.js';

test('高级主题默认使用系统配色并同步桌面与移动配置', () => {
  const settings = createDefaultThemeSettings();
  assert.equal(settings.version, 2);
  assert.equal(settings.basePreference, 'system');
  assert.equal(settings.colorStyle, 'neutral');
  assert.equal(settings.textScale, 'standard');
  assert.equal(settings.linkedProfiles, true);
  assert.deepEqual(settings.mobile, settings.desktop);
});

test('v1 输入保留当前色彩与字号并统一输出 v2', () => {
  const current = { ...createDefaultThemeSettings(), colorStyle: 'aurora' as const, textScale: 'large' as const };
  const legacy = projectThemeSettingsV1(current);
  const next = parseThemeSettings({
    ...legacy,
    basePreference: 'dark',
  }, 456, current);
  assert.equal(next.version, 2);
  assert.equal(next.basePreference, 'dark');
  assert.equal(next.colorStyle, 'aurora');
  assert.equal(next.textScale, 'large');
  assert.equal(next.updatedAt, 456);
});

test('v2 输入更新色彩与字号且 v1 投影保持旧读取器可读', () => {
  const next = parseThemeSettings({
    ...createDefaultThemeSettings(),
    colorStyle: 'aurora',
    textScale: 'compact',
  }, 789);
  assert.equal(next.colorStyle, 'aurora');
  assert.equal(next.textScale, 'compact');
  assert.deepEqual(projectThemeSettingsV1(next), {
    version: 1,
    basePreference: 'system',
    linkedProfiles: true,
    desktop: next.desktop,
    mobile: next.mobile,
    updatedAt: 789,
  });
});

test('保持同步时以桌面配置覆盖移动配置', () => {
  const current = createDefaultThemeSettings();
  const next = parseThemeSettings({
    ...current,
    linkedProfiles: true,
    desktop: { ...current.desktop, backgroundKind: 'preset', backgroundValue: 'mist', panelOpacity: 0.82 },
    mobile: { ...current.mobile, backgroundKind: 'preset', backgroundValue: 'dusk' },
  }, 123);
  assert.deepEqual(next.mobile, next.desktop);
  assert.equal(next.updatedAt, 123);
});

test('无效或损坏的存储配置安全回退默认值', () => {
  assert.deepEqual(readStoredThemeSettings('{bad'), createDefaultThemeSettings());
  assert.doesNotThrow(() => parseThemeSettings({ ...createDefaultThemeSettings(), desktop: { ...createDefaultThemeSettings().desktop, panelOpacity: 0.35 } }));
  assert.throws(() => parseThemeSettings({ ...createDefaultThemeSettings(), desktop: { ...createDefaultThemeSettings().desktop, panelOpacity: 0.34 } }));
});

test('损坏的扩展列只回退新增维度而不丢失旧版背景', () => {
  const current = parseThemeSettings({
    ...createDefaultThemeSettings(),
    linkedProfiles: false,
    desktop: { ...createDefaultThemeSettings().desktop, backgroundKind: 'preset', backgroundValue: 'forest' },
  }, 123);
  const restored = readStoredThemeSettings(JSON.stringify(projectThemeSettingsV1(current)), 'bad', 'bad');
  assert.equal(restored.desktop.backgroundValue, 'forest');
  assert.equal(restored.colorStyle, 'neutral');
  assert.equal(restored.textScale, 'standard');
});

test('识别桌面或移动配置引用的私有背景资源', () => {
  const settings = createDefaultThemeSettings();
  const withAsset = parseThemeSettings({
    ...settings,
    linkedProfiles: false,
    mobile: { ...settings.mobile, backgroundKind: 'asset', backgroundValue: 'asset-1' },
  });
  assert.equal(themeSettingsReferencesAsset(withAsset, 'asset-1'), true);
  assert.equal(themeSettingsReferencesAsset(withAsset, 'asset-2'), false);
});
