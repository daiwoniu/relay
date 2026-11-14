import type { AccountThemeSettingsDto, ThemePreference } from '../generated/relay-contracts';

export const THEME_BOOTSTRAP_KEY = 'relay_theme_bootstrap_v2';

export interface ThemeBootstrapV2 {
  version: 2;
  basePreference: ThemePreference;
  colorStyle: AccountThemeSettingsDto['colorStyle'];
  textScale: AccountThemeSettingsDto['textScale'];
}

function isThemeBootstrap(value: unknown): value is ThemeBootstrapV2 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 4
    && record.version === 2
    && (record.basePreference === 'light' || record.basePreference === 'dark' || record.basePreference === 'system')
    && (record.colorStyle === 'neutral' || record.colorStyle === 'aurora')
    && (record.textScale === 'compact' || record.textScale === 'standard' || record.textScale === 'large');
}

export function createThemeBootstrap(
  settings: Pick<AccountThemeSettingsDto, 'basePreference' | 'colorStyle' | 'textScale'>,
): ThemeBootstrapV2 {
  return {
    version: 2,
    basePreference: settings.basePreference,
    colorStyle: settings.colorStyle,
    textScale: settings.textScale,
  };
}

export function readThemeBootstrap(storage: Pick<Storage, 'getItem'> = localStorage): ThemeBootstrapV2 | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(THEME_BOOTSTRAP_KEY) || 'null');
    return isThemeBootstrap(value) ? value : null;
  } catch { return null; }
}

export function writeThemeBootstrap(
  settings: Pick<AccountThemeSettingsDto, 'basePreference' | 'colorStyle' | 'textScale'>,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try { storage.setItem(THEME_BOOTSTRAP_KEY, JSON.stringify(createThemeBootstrap(settings))); } catch {}
}

export function resetThemeBootstrap(
  basePreference: ThemePreference,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  writeThemeBootstrap({ basePreference, colorStyle: 'neutral', textScale: 'standard' }, storage);
}

export function resetThemeBootstrapFromLocalPreference(
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): void {
  let preference: ThemePreference = 'system';
  try {
    const stored = storage.getItem('relay_theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') preference = stored;
  } catch {}
  resetThemeBootstrap(preference, storage);
}
