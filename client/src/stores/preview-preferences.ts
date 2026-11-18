import { create } from 'zustand';
import { jsonBody, requestJson } from '../api/client';
import { PREVIEW_CAPACITY_PRESETS, PREVIEW_IMAGE_PRESETS, type PreviewPreferences } from '../generated/relay-contracts';

export function defaultPreviewPreferences(): PreviewPreferences {
  return { capacityPreset: 'default', imagePreset: 'default', customCapacity: { ...PREVIEW_CAPACITY_PRESETS.default }, customImage: { ...PREVIEW_IMAGE_PRESETS.default } };
}
interface State {
  userId: string | null;
  admin: boolean;
  preferences: PreviewPreferences;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error: string;
  revision: number;
  configure: (userId: string | null, admin?: boolean) => void;
  load: () => Promise<void>;
  save: (changes: Partial<PreviewPreferences>) => Promise<void>;
}
let epoch = 0;
export const usePreviewPreferences = create<State>((set, get) => ({
  userId: null, admin: false, preferences: defaultPreviewPreferences(), loaded: false, loading: false, saving: false, error: '', revision: 0,
  configure(userId, admin = false) {
    if (get().userId === userId && get().admin === admin) return;
    epoch++;
    set({ userId, admin, preferences: defaultPreviewPreferences(), loaded: false, loading: false, saving: false, error: '', revision: 0 });
  },
  async load() {
    if (!get().userId || get().loading || get().saving) return;
    const generation = epoch;
    set({ loading: true, error: '' });
    try {
      const preferences = await requestJson<PreviewPreferences>('/api/auth/preview-preferences');
      if (generation === epoch) set(state => ({ preferences, loaded: true, loading: false, revision: state.revision + (JSON.stringify(state.preferences) !== JSON.stringify(preferences) ? 1 : 0) }));
    } catch (error) {
      if (generation === epoch) set({ loading: false, error: error instanceof Error ? error.message : '读取预览设置失败' });
    }
  },
  async save(changes) {
    if (!get().userId || !get().loaded || get().saving || get().loading) return;
    if (Object.entries(changes).every(([key, value]) => JSON.stringify(get().preferences[key as keyof PreviewPreferences]) === JSON.stringify(value))) return;
    const generation = epoch;
    set({ saving: true, error: '' });
    try {
      const preferences = await requestJson<PreviewPreferences>('/api/auth/preview-preferences', { method: 'PATCH', ...jsonBody(changes) });
      if (generation === epoch) set(state => ({ preferences, saving: false, revision: state.revision + 1 }));
    } catch (error) {
      if (generation === epoch) set({ saving: false, error: error instanceof Error ? error.message : '保存失败，请重试' });
    }
  },
}));
export function getEffectivePreviewPreferences() {
  const { preferences: p, admin } = usePreviewPreferences.getState();
  return {
    capacity: p.capacityPreset === 'custom' && admin ? p.customCapacity : PREVIEW_CAPACITY_PRESETS[p.capacityPreset === 'custom' ? 'default' : p.capacityPreset],
    image: p.imagePreset === 'custom' && admin ? p.customImage : PREVIEW_IMAGE_PRESETS[p.imagePreset === 'custom' ? 'default' : p.imagePreset],
  };
}
