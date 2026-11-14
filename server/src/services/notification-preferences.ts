import {
  getNotificationPreferences,
  updateNotificationPreferences,
  type NotificationPreferences,
  type NotificationPreferencesUpdate,
} from '../db/queries.js';

export interface NotificationPreferencesRepository {
  get(userId: string): NotificationPreferences;
  update(userId: string, updates: NotificationPreferencesUpdate): NotificationPreferences;
}

const defaultRepository: NotificationPreferencesRepository = {
  get: getNotificationPreferences,
  update: updateNotificationPreferences,
};

export function readNotificationPreferences(userId: string, repository = defaultRepository): NotificationPreferences {
  return repository.get(userId);
}

export function saveNotificationPreferences(userId: string, updates: NotificationPreferencesUpdate, repository = defaultRepository): NotificationPreferences {
  return repository.update(userId, updates);
}
