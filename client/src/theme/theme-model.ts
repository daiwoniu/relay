import type { AccountThemeSettingsDto, ThemePreference, ThemeProfileDto } from '../generated/relay-contracts';
import { THEME_PRESET_IDS } from './theme-presets.ts';

export type ThemeDevice = 'desktop' | 'mobile';
export type EffectiveTheme = 'light' | 'dark';
export const THEME_DESKTOP_BREAKPOINT = 768;

export function createDefaultThemeProfile(): ThemeProfileDto {
  return { backgroundKind: 'none', backgroundValue: null, blur: 0, fit: 'cover', position: 'center', overlayColor: '#000000', overlayOpacity: 0, panelOpacity: 1, glassBlur: 0, borderStrength: 0.55 };
}

export function createDefaultThemeSettings(basePreference: ThemePreference = 'system'): AccountThemeSettingsDto {
  return { version: 2, basePreference, colorStyle: 'neutral', textScale: 'standard', linkedProfiles: true, desktop: createDefaultThemeProfile(), mobile: createDefaultThemeProfile(), updatedAt: 0 };
}

export function getThemeDevice(width: number): ThemeDevice {
  return width >= THEME_DESKTOP_BREAKPOINT ? 'desktop' : 'mobile';
}

export function getThemeProfile(settings: AccountThemeSettingsDto, device: ThemeDevice): ThemeProfileDto {
  return settings.linkedProfiles ? settings.desktop : settings[device];
}

export function setThemeProfile(settings: AccountThemeSettingsDto, device: ThemeDevice, profile: ThemeProfileDto): AccountThemeSettingsDto {
  if (settings.linkedProfiles) return { ...settings, desktop: { ...profile }, mobile: { ...profile } };
  return { ...settings, [device]: { ...profile } };
}

export function copyThemeProfile(settings: AccountThemeSettingsDto, from: ThemeDevice): AccountThemeSettingsDto {
  const target: ThemeDevice = from === 'desktop' ? 'mobile' : 'desktop';
  return { ...settings, [target]: { ...settings[from] } };
}

export function setLinkedThemeProfiles(settings: AccountThemeSettingsDto, linked: boolean): AccountThemeSettingsDto {
  return linked ? { ...settings, linkedProfiles: true, mobile: { ...settings.desktop } } : { ...settings, linkedProfiles: false, desktop: { ...settings.desktop }, mobile: { ...settings.desktop } };
}

export function nextThemePreference(preference: ThemePreference): ThemePreference {
  if (preference === 'system') return 'light';
  if (preference === 'light') return 'dark';
  return 'system';
}

export function resolveEffectiveTheme(preference: ThemePreference, systemDark: boolean): EffectiveTheme {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}

export function themeCacheKey(userId: string): string {
  return `relay_theme_settings_v2:${userId}`;
}

export function legacyThemeCacheKey(userId: string): string {
  return `relay_theme_settings_v1:${userId}`;
}

function isNumberInRange(value: unknown, min: number, max: number, integer = false): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
}

function isThemeProfile(value: unknown): value is ThemeProfileDto {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Record<string, unknown>;
  const backgroundKind = profile.backgroundKind;
  const backgroundValue = profile.backgroundValue;
  const validBackground = backgroundKind === 'none'
    ? backgroundValue === null
    : backgroundKind === 'preset'
      ? typeof backgroundValue === 'string' && THEME_PRESET_IDS.includes(backgroundValue as typeof THEME_PRESET_IDS[number])
      : backgroundKind === 'asset' && typeof backgroundValue === 'string' && backgroundValue.length > 0 && backgroundValue.length <= 100;
  return validBackground
    && isNumberInRange(profile.blur, 0, 24, true)
    && (profile.fit === 'cover' || profile.fit === 'contain')
    && ['center', 'top', 'bottom', 'left', 'right'].includes(String(profile.position))
    && typeof profile.overlayColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(profile.overlayColor)
    && isNumberInRange(profile.overlayOpacity, 0, 0.75)
    && isNumberInRange(profile.panelOpacity, 0.35, 1)
    && isNumberInRange(profile.glassBlur, 0, 24, true)
    && isNumberInRange(profile.borderStrength, 0, 1);
}

function isAccountThemeSettings(value: unknown): value is AccountThemeSettingsDto {
  if (!value || typeof value !== 'object') return false;
  const settings = value as Record<string, unknown>;
  return settings.version === 2
    && (settings.basePreference === 'light' || settings.basePreference === 'dark' || settings.basePreference === 'system')
    && (settings.colorStyle === 'neutral' || settings.colorStyle === 'aurora')
    && (settings.textScale === 'compact' || settings.textScale === 'standard' || settings.textScale === 'large')
    && typeof settings.linkedProfiles === 'boolean'
    && isThemeProfile(settings.desktop)
    && isThemeProfile(settings.mobile)
    && isNumberInRange(settings.updatedAt, 0, Number.MAX_SAFE_INTEGER, true);
}

function migrateLegacyThemeSettings(value: unknown): AccountThemeSettingsDto | null {
  if (!value || typeof value !== 'object') return null;
  const settings = value as Record<string, unknown>;
  if (settings.version !== 1
    || !(settings.basePreference === 'light' || settings.basePreference === 'dark' || settings.basePreference === 'system')
    || typeof settings.linkedProfiles !== 'boolean'
    || !isThemeProfile(settings.desktop)
    || !isThemeProfile(settings.mobile)
    || !isNumberInRange(settings.updatedAt, 0, Number.MAX_SAFE_INTEGER, true)) return null;
  return {
    version: 2,
    basePreference: settings.basePreference,
    colorStyle: 'neutral',
    textScale: 'standard',
    linkedProfiles: settings.linkedProfiles,
    desktop: settings.desktop,
    mobile: settings.mobile,
    updatedAt: settings.updatedAt,
  };
}

export function readCachedThemeSettings(userId: string): AccountThemeSettingsDto | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(themeCacheKey(userId)) || 'null');
    if (isAccountThemeSettings(value)) return value;
    const legacy: unknown = JSON.parse(localStorage.getItem(legacyThemeCacheKey(userId)) || 'null');
    const migrated = migrateLegacyThemeSettings(legacy);
    if (!migrated) return null;
    localStorage.setItem(themeCacheKey(userId), JSON.stringify(migrated));
    localStorage.removeItem(legacyThemeCacheKey(userId));
    return migrated;
  } catch { return null; }
}

export function writeCachedThemeSettings(userId: string, settings: AccountThemeSettingsDto): void {
  try { localStorage.setItem(themeCacheKey(userId), JSON.stringify(settings)); } catch {}
}

export function getReferencedThemeAssetIds(settings: AccountThemeSettingsDto): string[] {
  return [...new Set([settings.desktop, settings.mobile]
    .filter((profile) => profile.backgroundKind === 'asset' && profile.backgroundValue)
    .map((profile) => profile.backgroundValue as string))];
}

export function getUnusedPendingThemeAssetIds(pendingAssetIds: readonly string[], settings: AccountThemeSettingsDto): string[] {
  const referenced = new Set(getReferencedThemeAssetIds(settings));
  return pendingAssetIds.filter((assetId) => !referenced.has(assetId));
}
