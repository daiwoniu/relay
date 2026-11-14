import assert from 'node:assert/strict';
import test from 'node:test';
import { readNotificationPreferences, saveNotificationPreferences, type NotificationPreferencesRepository } from './notification-preferences.js';

test('通知偏好服务按用户读取并保存部分更新', () => {
  const values = new Map();
  const defaults = {
    desktopSystemEnabled: false, desktopSoundEnabled: false,
    desktopSessionEndSystemEnabled: false, desktopSessionEndSoundEnabled: false,
    mobileSystemEnabled: false, mobileSoundEnabled: false,
    mobileSessionEndSystemEnabled: false, mobileSessionEndSoundEnabled: false,
    approvalSound: 'gentle_dual' as const, sessionEndSound: 'crisp' as const,
    desktopSoundVolume: 45, mobileSoundVolume: 80,
  };
  const repository: NotificationPreferencesRepository = {
    get: (userId) => values.get(userId) || defaults,
    update: (userId, updates) => {
      const next = { ...defaults, ...values.get(userId), ...updates };
      values.set(userId, next);
      return next;
    },
  };
  assert.deepEqual(readNotificationPreferences('user-1', repository), defaults);
  assert.deepEqual(saveNotificationPreferences('user-1', { mobileSessionEndSystemEnabled: true, sessionEndSound: 'short_tone' }, repository), { ...defaults, mobileSessionEndSystemEnabled: true, sessionEndSound: 'short_tone' });
  assert.deepEqual(readNotificationPreferences('user-2', repository), defaults);
});
