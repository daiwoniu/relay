import {
  ThemeColorStyleSchema,
  ThemeSettingsInputSchema,
  ThemeSettingsV1Schema,
  ThemeTextScaleSchema,
  type AccountThemeSettingsDto,
  type ThemeSettingsV1,
  type ThemeProfileDto,
} from '../contracts/index.js';

export const THEME_PRESET_IDS = ['mist', 'dusk', 'forest', 'ember'] as const;

export function createDefaultThemeProfile(): ThemeProfileDto {
  return {
    backgroundKind: 'none',
    backgroundValue: null,
    blur: 0,
    fit: 'cover',
    position: 'center',
    overlayColor: '#000000',
    overlayOpacity: 0,
    panelOpacity: 1,
    glassBlur: 0,
    borderStrength: 0.55,
  };
}

export function createDefaultThemeSettings(updatedAt = 0): AccountThemeSettingsDto {
  return {
    version: 2,
    basePreference: 'system',
    colorStyle: 'neutral',
    textScale: 'standard',
    linkedProfiles: true,
    desktop: createDefaultThemeProfile(),
    mobile: createDefaultThemeProfile(),
    updatedAt,
  };
}

function validateBackground(profile: ThemeProfileDto): void {
  if (profile.backgroundKind === 'none' && profile.backgroundValue !== null) {
    throw new Error('无背景模式不能包含背景引用');
  }
  if (profile.backgroundKind === 'preset' && !THEME_PRESET_IDS.includes(profile.backgroundValue as typeof THEME_PRESET_IDS[number])) {
    throw new Error('内置背景不存在');
  }
  if (profile.backgroundKind === 'asset' && !profile.backgroundValue) {
    throw new Error('自定义背景缺少资源引用');
  }
}

export function projectThemeSettingsV1(settings: AccountThemeSettingsDto): ThemeSettingsV1 {
  return ThemeSettingsV1Schema.parse({
    version: 1,
    basePreference: settings.basePreference,
    linkedProfiles: settings.linkedProfiles,
    desktop: settings.desktop,
    mobile: settings.mobile,
    updatedAt: settings.updatedAt,
  });
}

export function parseThemeSettings(
  input: unknown,
  updatedAt = Date.now(),
  previous: Pick<AccountThemeSettingsDto, 'colorStyle' | 'textScale'> = createDefaultThemeSettings(),
): AccountThemeSettingsDto {
  const parsed = ThemeSettingsInputSchema.parse({
    ...(input as Record<string, unknown>),
    updatedAt,
  });
  const normalized: AccountThemeSettingsDto = {
    ...parsed,
    version: 2,
    colorStyle: parsed.version === 2 ? parsed.colorStyle : previous.colorStyle,
    textScale: parsed.version === 2 ? parsed.textScale : previous.textScale,
  };
  validateBackground(normalized.desktop);
  validateBackground(normalized.mobile);
  if (!normalized.linkedProfiles) return normalized;
  return { ...normalized, mobile: { ...normalized.desktop } };
}

export function readStoredThemeSettings(
  raw: string | null | undefined,
  colorStyle: unknown = 'neutral',
  textScale: unknown = 'standard',
): AccountThemeSettingsDto {
  if (!raw) return createDefaultThemeSettings();
  try {
    const parsedColorStyle = ThemeColorStyleSchema.safeParse(colorStyle);
    const parsedTextScale = ThemeTextScaleSchema.safeParse(textScale);
    const stored = ThemeSettingsInputSchema.parse(JSON.parse(raw));
    return parseThemeSettings(stored, stored.updatedAt, {
      colorStyle: stored.version === 2 ? stored.colorStyle : parsedColorStyle.success ? parsedColorStyle.data : 'neutral',
      textScale: stored.version === 2 ? stored.textScale : parsedTextScale.success ? parsedTextScale.data : 'standard',
    });
  } catch {
    return createDefaultThemeSettings();
  }
}

export function themeSettingsReferencesAsset(settings: AccountThemeSettingsDto, assetId: string): boolean {
  return getThemeAssetIds(settings).includes(assetId);
}

export function getThemeAssetIds(settings: AccountThemeSettingsDto): string[] {
  return [...new Set([settings.desktop, settings.mobile]
    .filter((profile) => profile.backgroundKind === 'asset' && profile.backgroundValue)
    .map((profile) => profile.backgroundValue as string))];
}
