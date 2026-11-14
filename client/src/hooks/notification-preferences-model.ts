import type { NotificationPreferencesDto } from '../generated/relay-contracts.ts';

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferencesDto = {
  desktopSystemEnabled: false,
  desktopSoundEnabled: false,
  desktopSessionEndSystemEnabled: false,
  desktopSessionEndSoundEnabled: false,
  mobileSystemEnabled: false,
  mobileSoundEnabled: false,
  mobileSessionEndSystemEnabled: false,
  mobileSessionEndSoundEnabled: false,
  approvalSound: 'gentle_dual',
  sessionEndSound: 'crisp',
  desktopSoundVolume: 45,
  mobileSoundVolume: 80,
};

export function mergeInitialNotificationPreferences(value: NotificationPreferencesDto): NotificationPreferencesDto {
  return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...value };
}

export function applyRemoteNotificationPreferences(current: NotificationPreferencesDto, remote: NotificationPreferencesDto, savingKeys: readonly (keyof NotificationPreferencesDto)[] = []): NotificationPreferencesDto {
  const next = { ...remote };
  for (const key of savingKeys) Object.assign(next, { [key]: current[key] });
  return next;
}

export function createOptimisticPreferenceUpdate<K extends keyof NotificationPreferencesDto>(current: NotificationPreferencesDto, key: K, value: NotificationPreferencesDto[K]) {
  return { optimistic: { ...current, [key]: value }, rollback: { ...current } };
}

export function applySavedNotificationPreference<K extends keyof NotificationPreferencesDto>(current: NotificationPreferencesDto, response: NotificationPreferencesDto, key: K): NotificationPreferencesDto {
  return { ...current, [key]: response[key] };
}

export function getBrowserNotificationAvailability(input: { supported: boolean; permission: NotificationPermission | 'unsupported'; accountEnabled: boolean }) {
  if (!input.supported || input.permission === 'unsupported') return input.accountEnabled ? 'enabled_unsupported' : 'unsupported';
  if (input.permission === 'denied') return input.accountEnabled ? 'enabled_denied' : 'denied';
  if (input.permission === 'granted') return input.accountEnabled ? 'available' : 'disabled';
  return input.accountEnabled ? 'permission_required' : 'disabled';
}

export function getBrowserNotificationPermission(input: {
  notificationAvailable: boolean;
  secureContext: boolean;
  permission?: NotificationPermission;
}): NotificationPermission | 'unsupported' {
  if (!input.notificationAvailable || !input.secureContext) return 'unsupported';
  return input.permission || 'default';
}

export function getNotificationPermissionTone(input: {
  currentDevice: boolean;
  accountEnabled: boolean;
  permission: NotificationPermission | 'unsupported';
}): 'neutral' | 'success' | 'warning' | 'danger' {
  if (!input.currentDevice || !input.accountEnabled) return 'neutral';
  if (input.permission === 'granted') return 'success';
  if (input.permission === 'denied') return 'danger';
  return 'warning';
}
