import type { NotificationPreferencesDto, NotificationPreferencesResponseDto } from '../generated/relay-contracts';
import { jsonBody, requestJson } from './client';

export function getNotificationPreferences(signal?: AbortSignal): Promise<NotificationPreferencesResponseDto> {
  return requestJson('/api/auth/notification-preferences', { signal });
}

export function updateNotificationPreferences(updates: Partial<NotificationPreferencesDto>): Promise<NotificationPreferencesResponseDto> {
  return requestJson('/api/auth/notification-preferences', { analytics:{feature:'settings',action:'save',surface:'settings',settingKey:'notification'},method: 'PATCH', ...jsonBody(updates) });
}
