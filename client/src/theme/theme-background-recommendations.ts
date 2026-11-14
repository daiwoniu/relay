import type { ThemeProfileDto } from '../generated/relay-contracts';
import { getThemeBackgroundPreset } from './theme-presets.ts';

type BackgroundKind = ThemeProfileDto['backgroundKind'];
type BackgroundRecommendation = Pick<ThemeProfileDto, 'blur' | 'fit' | 'position' | 'overlayColor' | 'overlayOpacity' | 'panelOpacity' | 'glassBlur' | 'borderStrength'>;

const NONE_RECOMMENDATION: BackgroundRecommendation = {
  blur: 0,
  fit: 'cover',
  position: 'center',
  overlayColor: '#000000',
  overlayOpacity: 0,
  panelOpacity: 1,
  glassBlur: 0,
  borderStrength: 0.55,
};

const IMAGE_RECOMMENDATION: BackgroundRecommendation = {
  blur: 1,
  fit: 'cover',
  position: 'center',
  overlayColor: '#000000',
  overlayOpacity: 0.18,
  panelOpacity: 0.52,
  glassBlur: 12,
  borderStrength: 0.7,
};

export function applyRecommendedThemeBackground(
  profile: ThemeProfileDto,
  backgroundKind: BackgroundKind,
  backgroundValue: string | null,
): ThemeProfileDto {
  if (profile.backgroundKind === backgroundKind && profile.backgroundValue === backgroundValue) return profile;
  const recommendation = backgroundKind === 'none'
    ? NONE_RECOMMENDATION
    : backgroundKind === 'asset'
      ? IMAGE_RECOMMENDATION
      : getThemeBackgroundPreset(backgroundValue)?.recommendation ?? IMAGE_RECOMMENDATION;
  return { ...profile, ...recommendation, backgroundKind, backgroundValue };
}
