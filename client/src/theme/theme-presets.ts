import type { ThemeProfileDto } from '../generated/relay-contracts';

type BackgroundRecommendation = Pick<ThemeProfileDto, 'blur' | 'fit' | 'position' | 'overlayColor' | 'overlayOpacity' | 'panelOpacity' | 'glassBlur' | 'borderStrength'>;

export const THEME_BACKGROUND_PRESETS = [
  {
    id: 'mist', label: '晨雾',
    background: 'radial-gradient(circle at 18% 16%, #dbeafe 0, transparent 38%), radial-gradient(circle at 82% 72%, #e0e7ff 0, transparent 42%), linear-gradient(135deg, #f8fafc, #dbe4ee)',
    recommendation: { blur: 1, fit: 'cover', position: 'center', overlayColor: '#dbeafe', overlayOpacity: 0.08, panelOpacity: 0.58, glassBlur: 10, borderStrength: 0.64 },
  },
  {
    id: 'dusk', label: '暮色',
    background: 'radial-gradient(circle at 18% 20%, #4c5275 0, transparent 34%), radial-gradient(circle at 78% 72%, #6b3f58 0, transparent 40%), linear-gradient(145deg, #171924, #31283b)',
    recommendation: { blur: 2, fit: 'cover', position: 'center', overlayColor: '#090b16', overlayOpacity: 0.2, panelOpacity: 0.48, glassBlur: 14, borderStrength: 0.76 },
  },
  {
    id: 'forest', label: '苔林',
    background: 'radial-gradient(circle at 74% 18%, #7b9b7a 0, transparent 32%), radial-gradient(circle at 22% 78%, #315c53 0, transparent 40%), linear-gradient(140deg, #d5dfcf, #557268)',
    recommendation: { blur: 2, fit: 'cover', position: 'center', overlayColor: '#10251f', overlayOpacity: 0.14, panelOpacity: 0.52, glassBlur: 12, borderStrength: 0.7 },
  },
  {
    id: 'ember', label: '余烬',
    background: 'radial-gradient(circle at 72% 28%, #d97757 0, transparent 34%), radial-gradient(circle at 20% 72%, #7c4a5b 0, transparent 42%), linear-gradient(140deg, #f1c7a6, #5d3949)',
    recommendation: { blur: 2, fit: 'cover', position: 'center', overlayColor: '#2b1720', overlayOpacity: 0.16, panelOpacity: 0.5, glassBlur: 12, borderStrength: 0.72 },
  },
] as const satisfies readonly { id: string; label: string; background: string; recommendation: BackgroundRecommendation }[];

export const THEME_PRESET_IDS = THEME_BACKGROUND_PRESETS.map((preset) => preset.id);

export function getThemeBackgroundPreset(id: string | null | undefined) {
  return THEME_BACKGROUND_PRESETS.find((preset) => preset.id === id);
}
