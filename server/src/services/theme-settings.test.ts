import assert from 'node:assert/strict';
import test from 'node:test';
import type { AccountThemeSettingsDto } from '../contracts/index.js';
import { createDefaultThemeSettings } from '../theme/theme-settings.js';
import { createThemeSettingsService, type ThemeSettingsRepository } from './theme-settings.js';

test('保存主题时拒绝引用其他账号的背景资源', () => {
  let current = createDefaultThemeSettings();
  const repository: ThemeSettingsRepository = {
    readSettings: () => current,
    saveSettings: (_userId, settings) => (current = settings),
    createAsset: (record) => record,
    getAsset: () => ({ id: 'asset-1', user_id: 'user-2', created_at: 1 }),
    deleteAsset() {},
  };
  const service = createThemeSettingsService(repository, { writePair() {}, read() { return null; }, delete() {} } as never);
  assert.throws(() => service.save('user-1', {
    ...current,
    linkedProfiles: false,
    desktop: { ...current.desktop, backgroundKind: 'asset', backgroundValue: 'asset-1' },
  }), /资源不存在/);
});

test('新配置保存成功后清理不再引用的旧背景资源', () => {
  const defaults = createDefaultThemeSettings();
  let current: AccountThemeSettingsDto = {
    ...defaults,
    linkedProfiles: false,
    desktop: { ...defaults.desktop, backgroundKind: 'asset' as const, backgroundValue: 'asset-old' },
  };
  const deletedRecords: string[] = [];
  const deletedFiles: string[] = [];
  const repository: ThemeSettingsRepository = {
    readSettings: () => current,
    saveSettings: (_userId, settings) => (current = settings),
    createAsset: (record) => record,
    getAsset: (assetId) => ({ id: assetId, user_id: 'user-1', created_at: 1 }),
    deleteAsset: (assetId) => { deletedRecords.push(assetId); },
  };
  const service = createThemeSettingsService(repository, {
    writePair() {},
    read() { return null; },
    delete(_userId: string, assetId: string) { deletedFiles.push(assetId); },
  } as never);
  service.save('user-1', {
    ...current,
    desktop: { ...current.desktop, backgroundKind: 'preset', backgroundValue: 'mist' },
  });
  assert.deepEqual(deletedRecords, ['asset-old']);
  assert.deepEqual(deletedFiles, ['asset-old']);
});

test('旧背景仍被任一设备配置引用时保持资源不变', () => {
  const defaults = createDefaultThemeSettings();
  let current: AccountThemeSettingsDto = {
    ...defaults,
    linkedProfiles: false,
    desktop: { ...defaults.desktop, backgroundKind: 'asset', backgroundValue: 'asset-shared' },
    mobile: { ...defaults.mobile, backgroundKind: 'asset', backgroundValue: 'asset-shared' },
  };
  const deleted: string[] = [];
  const repository: ThemeSettingsRepository = {
    readSettings: () => current,
    saveSettings: (_userId, settings) => (current = settings),
    createAsset: (record) => record,
    getAsset: (assetId) => ({ id: assetId, user_id: 'user-1', created_at: 1 }),
    deleteAsset: (assetId) => { deleted.push(assetId); },
  };
  const service = createThemeSettingsService(repository, { writePair() {}, read() { return null; }, delete() {} } as never);
  service.save('user-1', {
    ...current,
    desktop: { ...current.desktop, backgroundKind: 'preset', backgroundValue: 'mist' },
  });
  assert.deepEqual(deleted, []);
});

test('旧版 v1 保存只更新原字段并保留当前色彩与字号', () => {
  const defaults = createDefaultThemeSettings();
  let current: AccountThemeSettingsDto = { ...defaults, colorStyle: 'aurora', textScale: 'large' };
  const repository: ThemeSettingsRepository = {
    readSettings: () => current,
    saveSettings: (_userId, settings) => (current = settings),
    createAsset: (record) => record,
    getAsset: () => undefined,
    deleteAsset() {},
  };
  const service = createThemeSettingsService(repository, { writePair() {}, read() { return null; }, delete() {} } as never);
  const { colorStyle: _colorStyle, textScale: _textScale, ...legacyFields } = current;
  const saved = service.save('user-1', { ...legacyFields, version: 1, basePreference: 'dark' });
  assert.equal(saved.version, 2);
  assert.equal(saved.basePreference, 'dark');
  assert.equal(saved.colorStyle, 'aurora');
  assert.equal(saved.textScale, 'large');
});
