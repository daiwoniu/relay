import type { AccountThemeSettingsDto, AccountThemeSettingsResponseDto, ThemeAssetResponseDto } from '../generated/relay-contracts';
import { jsonBody, requestJson } from './client';

export function getThemeSettings(signal?: AbortSignal): Promise<AccountThemeSettingsResponseDto> {
  return requestJson('/api/auth/theme-settings', { signal });
}

export function saveThemeSettings(settings: AccountThemeSettingsDto): Promise<AccountThemeSettingsResponseDto> {
  return requestJson('/api/auth/theme-settings', { analytics:{feature:'settings',action:'save',surface:'settings',settingKey:'theme'},method: 'PUT', ...jsonBody(settings) });
}

export function uploadThemeAsset(desktop: Blob, mobile: Blob): Promise<ThemeAssetResponseDto> {
  const body = new FormData();
  body.append('desktop', desktop, 'desktop.webp');
  body.append('mobile', mobile, 'mobile.webp');
  return requestJson('/api/auth/theme-assets', { analytics:{feature:'settings',action:'upload_asset',surface:'settings'},method: 'POST', body });
}

export function deleteThemeAsset(assetId: string): Promise<{ ok: true }> {
  return requestJson(`/api/auth/theme-assets/${encodeURIComponent(assetId)}`, { analytics:{feature:'settings',action:'delete_asset',surface:'settings'},method: 'DELETE' });
}

export function getThemeAssetUrl(assetId: string, variant: 'desktop' | 'mobile'): string {
  return `/api/auth/theme-assets/${encodeURIComponent(assetId)}/${variant}`;
}
