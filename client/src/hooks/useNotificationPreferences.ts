import { useEffect } from 'react';
import { create } from 'zustand';
import type { NotificationPreferencesDto } from '../generated/relay-contracts';
import { getNotificationPreferences, updateNotificationPreferences } from '../api/notification-preferences';
import { getCurrentDeviceCategory } from '../notifications/device-category';
import { applyRemoteNotificationPreferences, applySavedNotificationPreference, createOptimisticPreferenceUpdate, DEFAULT_NOTIFICATION_PREFERENCES, mergeInitialNotificationPreferences } from './notification-preferences-model';
export { getBrowserNotificationAvailability } from './notification-preferences-model';

interface NotificationPreferencesState {
  userId: string | null;
  preferences: NotificationPreferencesDto;
  loaded: boolean;
  savingKeys: (keyof NotificationPreferencesDto)[];
  error: string;
  configure(userId: string | null): void;
  applyRemote(preferences: NotificationPreferencesDto): void;
  patch<K extends keyof NotificationPreferencesDto>(key: K, value: NotificationPreferencesDto[K]): Promise<void>;
  clearError(): void;
}

export const useNotificationPreferencesStore = create<NotificationPreferencesState>((set, get) => ({
  userId: null,
  preferences: DEFAULT_NOTIFICATION_PREFERENCES,
  loaded: false,
  savingKeys: [],
  error: '',
  configure: (userId) => {
    if (get().userId === userId) return;
    set({ userId, preferences: DEFAULT_NOTIFICATION_PREFERENCES, loaded: false, savingKeys: [], error: '' });
    if (!userId) return;
    void getNotificationPreferences()
      .then(({ preferences }) => {
        if (get().userId === userId) set({ preferences: mergeInitialNotificationPreferences(preferences), loaded: true });
      })
      .catch((reason) => {
        if (get().userId === userId) set({ loaded: true, error: reason instanceof Error ? reason.message : '读取通知设置失败' });
      });
  },
  applyRemote: (preferences) => set((state) => ({ preferences: applyRemoteNotificationPreferences(state.preferences, preferences, state.savingKeys), loaded: true, error: '' })),
  patch: async (key, value) => {
    const before = get().preferences;
    const update = createOptimisticPreferenceUpdate(before, key, value);
    set((state) => ({ preferences: update.optimistic, savingKeys: [...new Set([...state.savingKeys, key])], error: '' }));
    try {
      const response = await updateNotificationPreferences({ [key]: value });
      set((state) => ({ preferences: applySavedNotificationPreference(state.preferences, response.preferences, key), savingKeys: state.savingKeys.filter((candidate) => candidate !== key) }));
    } catch (reason) {
      set((state) => ({ preferences: { ...state.preferences, [key]: update.rollback[key] }, savingKeys: state.savingKeys.filter((candidate) => candidate !== key), error: reason instanceof Error ? reason.message : '保存通知设置失败' }));
      throw reason;
    }
  },
  clearError: () => set({ error: '' }),
}));

export function applyNotificationPreferencesUpdate(preferences: NotificationPreferencesDto): void {
  useNotificationPreferencesStore.getState().applyRemote(preferences);
}

export function useNotificationPreferences(userId: string | null) {
  const state = useNotificationPreferencesStore();
  useEffect(() => state.configure(userId), [state.configure, userId]);
  return { ...state, deviceCategory: getCurrentDeviceCategory() };
}
