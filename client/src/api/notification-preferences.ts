import type { NotificationPreferencesDto, NotificationPreferencesResponseDto } from '../generated/relay-contracts';
import { jsonBody, requestJson } from './client';

export function getNotificationPreferences(signal?: AbortSignal): Promise<NotificationPreferencesResponseDto> {
  return requestJson('/api/auth/notification-preferences', { signal });
}

export function updateNotificationPreferences(updates: Partial<NotificationPreferencesDto>): Promise<NotificationPreferencesResponseDto> {
  return requestJson('/api/auth/notification-preferences', { method: 'PATCH', ...jsonBody(updates) });
}
