import { v4 as uuid } from 'uuid';
import type { AccountThemeSettingsDto } from '../contracts/index.js';
import {
  createThemeAssetRecord,
  deleteThemeAssetRecord,
  getThemeAssetRecord,
  getThemeSettings,
  saveThemeSettings as saveThemeSettingsRecord,
  type ThemeAssetRecord,
} from '../db/queries.js';
import { getThemeAssetIds, parseThemeSettings, themeSettingsReferencesAsset } from '../theme/theme-settings.js';
import { ThemeAssetFilesystem, type ThemeAssetVariant } from '../theme/theme-assets.js';

export interface ThemeSettingsRepository {
  readSettings(userId: string): AccountThemeSettingsDto;
  saveSettings(userId: string, settings: AccountThemeSettingsDto): AccountThemeSettingsDto;
  createAsset(record: ThemeAssetRecord): ThemeAssetRecord;
  getAsset(assetId: string): ThemeAssetRecord | undefined;
  deleteAsset(assetId: string): void;
}

const defaultRepository: ThemeSettingsRepository = {
  readSettings: getThemeSettings,
  saveSettings: saveThemeSettingsRecord,
  createAsset: createThemeAssetRecord,
  getAsset: getThemeAssetRecord,
  deleteAsset: deleteThemeAssetRecord,
};

export function createThemeSettingsService(
  repository: ThemeSettingsRepository = defaultRepository,
  filesystem = new ThemeAssetFilesystem(),
) {
  return {
    read(userId: string) {
      return repository.readSettings(userId);
    },
    save(userId: string, input: unknown) {
      const previous = repository.readSettings(userId);
      const settings = parseThemeSettings(input, Date.now(), previous);
      for (const profile of [settings.desktop, settings.mobile]) {
        if (profile.backgroundKind !== 'asset' || !profile.backgroundValue) continue;
        const asset = repository.getAsset(profile.backgroundValue);
        if (!asset || asset.user_id !== userId) throw new Error('主题背景资源不存在');
      }
      const saved = repository.saveSettings(userId, settings);
      const retainedAssetIds = new Set(getThemeAssetIds(saved));
      for (const assetId of getThemeAssetIds(previous)) {
        if (retainedAssetIds.has(assetId)) continue;
        const asset = repository.getAsset(assetId);
        if (!asset || asset.user_id !== userId) continue;
        try {
          repository.deleteAsset(assetId);
          filesystem.delete(userId, assetId);
        } catch (error) {
          console.warn(`[Relay] 旧主题背景清理失败: ${assetId}`, error);
        }
      }
      return saved;
    },
    createAsset(userId: string, desktop: Uint8Array, mobile: Uint8Array) {
      const assetId = uuid();
      filesystem.writePair(userId, assetId, desktop, mobile);
      try {
        repository.createAsset({ id: assetId, user_id: userId, created_at: Date.now() });
      } catch (error) {
        filesystem.delete(userId, assetId);
        throw error;
      }
      return assetId;
    },
    readAsset(userId: string, assetId: string, variant: ThemeAssetVariant) {
      const asset = repository.getAsset(assetId);
      if (!asset || asset.user_id !== userId) return null;
      return filesystem.read(userId, assetId, variant);
    },
    deleteAsset(userId: string, assetId: string) {
      const asset = repository.getAsset(assetId);
      if (!asset || asset.user_id !== userId) return false;
      if (themeSettingsReferencesAsset(repository.readSettings(userId), assetId)) {
        throw new Error('请先取消使用该背景');
      }
      repository.deleteAsset(assetId);
      filesystem.delete(userId, assetId);
      return true;
    },
  };
}
