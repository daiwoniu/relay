import type { AccountThemeSettingsDto, ThemeProfileDto } from '../generated/relay-contracts';
import type { EffectiveTheme } from './theme-model';
import type { ThemeScope } from './theme-scope';

export function hasAdvancedTheme(profile: ThemeProfileDto): boolean {
  return profile.backgroundKind !== 'none' || profile.panelOpacity < 1 || profile.glassBlur > 0 || profile.borderStrength !== 0.55;
}

const THEME_RUNTIME_STYLE_PROPERTIES = [
  '--theme-panel-opacity-input',
  '--theme-glass-blur-input',
  '--theme-border-strength',
  '--theme-border-outline-width',
  '--theme-surface-border',
  '--theme-surface-border-light',
] as const;

export function clearThemeRuntime(root: HTMLElement = document.documentElement): void {
  delete root.dataset.advancedTheme;
  delete root.dataset.colorStyle;
  delete root.dataset.textScale;
  delete root.dataset.themeScope;
  for (const property of THEME_RUNTIME_STYLE_PROPERTIES) root.style.removeProperty(property);
}

export function applyThemeRuntime(
  effectiveTheme: EffectiveTheme,
  profile: ThemeProfileDto,
  colorStyle: AccountThemeSettingsDto['colorStyle'] = 'neutral',
  textScale: AccountThemeSettingsDto['textScale'] = 'standard',
  scope: ThemeScope = 'workspace',
): void {
  const root = document.documentElement;
  clearThemeRuntime(root);
  root.dataset.theme = effectiveTheme;
  root.dataset.colorStyle = colorStyle;
  root.dataset.textScale = textScale;
  root.dataset.themeScope = scope;
  root.dataset.advancedTheme = String(hasAdvancedTheme(profile));
  root.style.setProperty('--theme-panel-opacity-input', String(profile.panelOpacity));
  root.style.setProperty('--theme-glass-blur-input', `${profile.glassBlur}px`);
  root.style.setProperty('--theme-border-strength', String(profile.borderStrength));
  root.style.setProperty('--theme-border-outline-width', `${Math.max(0, (profile.borderStrength - 0.55) / 0.45).toFixed(2)}px`);
  root.style.setProperty('--theme-surface-border', effectiveTheme === 'dark'
    ? `rgb(148 163 184 / ${profile.borderStrength})`
    : `rgb(100 116 139 / ${profile.borderStrength})`);
  root.style.setProperty('--theme-surface-border-light', effectiveTheme === 'dark'
    ? `rgb(148 163 184 / ${profile.borderStrength * 0.58})`
    : `rgb(100 116 139 / ${profile.borderStrength * 0.58})`);
  const browserChromeColor = effectiveTheme === 'dark'
    ? colorStyle === 'aurora' ? '#12131d' : '#181818'
    : colorStyle === 'aurora' ? '#f7f8ff' : '#ffffff';
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', browserChromeColor);
}
