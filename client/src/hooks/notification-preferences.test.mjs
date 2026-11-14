import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRemoteNotificationPreferences, applySavedNotificationPreference, createOptimisticPreferenceUpdate, DEFAULT_NOTIFICATION_PREFERENCES, getBrowserNotificationAvailability, getBrowserNotificationPermission, getNotificationPermissionTone, mergeInitialNotificationPreferences } from './notification-preferences-model.ts';

test('初始 REST 数据与 WebSocket 远端更新均形成完整偏好', () => {
  const initial = mergeInitialNotificationPreferences({ ...DEFAULT_NOTIFICATION_PREFERENCES, desktopSystemEnabled: true });
  assert.equal(initial.desktopSystemEnabled, true);
  const remote = applyRemoteNotificationPreferences(initial, { ...DEFAULT_NOTIFICATION_PREFERENCES, mobileSoundEnabled: true });
  assert.deepEqual(remote, { ...DEFAULT_NOTIFICATION_PREFERENCES, mobileSoundEnabled: true });
});

test('默认偏好区分授权与会话结束音色，并按设备设置音量', () => {
  assert.equal(DEFAULT_NOTIFICATION_PREFERENCES.approvalSound, 'gentle_dual');
  assert.equal(DEFAULT_NOTIFICATION_PREFERENCES.sessionEndSound, 'crisp');
  assert.equal(DEFAULT_NOTIFICATION_PREFERENCES.desktopSoundVolume, 45);
  assert.equal(DEFAULT_NOTIFICATION_PREFERENCES.mobileSoundVolume, 80);
  assert.equal(DEFAULT_NOTIFICATION_PREFERENCES.desktopSessionEndSystemEnabled, false);
});

test('通知权限读取同时要求 Notification API 与安全上下文', () => {
  assert.equal(getBrowserNotificationPermission({ notificationAvailable: false, secureContext: true }), 'unsupported');
  assert.equal(getBrowserNotificationPermission({ notificationAvailable: true, secureContext: false, permission: 'granted' }), 'unsupported');
  assert.equal(getBrowserNotificationPermission({ notificationAvailable: true, secureContext: true, permission: 'denied' }), 'denied');
});

test('PATCH 乐观更新保留可回滚快照', () => {
  const current = { ...DEFAULT_NOTIFICATION_PREFERENCES, desktopSoundEnabled: true };
  const update = createOptimisticPreferenceUpdate(current, 'mobileSystemEnabled', true);
  assert.equal(update.optimistic.mobileSystemEnabled, true);
  assert.deepEqual(update.rollback, current);
});

test('PATCH 乐观更新支持音色和音量字段', () => {
  const tone = createOptimisticPreferenceUpdate(DEFAULT_NOTIFICATION_PREFERENCES, 'approvalSound', 'soft_chime');
  const volume = createOptimisticPreferenceUpdate(tone.optimistic, 'desktopSoundVolume', 65);
  assert.equal(volume.optimistic.approvalSound, 'soft_chime');
  assert.equal(volume.optimistic.desktopSoundVolume, 65);
  assert.equal(volume.rollback.desktopSoundVolume, 45);
});

test('并发保存时远端全量同步和旧响应不会覆盖其他待保存字段', () => {
  const optimistic = { ...DEFAULT_NOTIFICATION_PREFERENCES, desktopSystemEnabled: true, desktopSessionEndSoundEnabled: true };
  const staleRemote = { ...DEFAULT_NOTIFICATION_PREFERENCES, desktopSystemEnabled: true };
  const afterRemote = applyRemoteNotificationPreferences(optimistic, staleRemote, ['desktopSessionEndSoundEnabled']);
  assert.equal(afterRemote.desktopSessionEndSoundEnabled, true);
  const afterFirstResponse = applySavedNotificationPreference(afterRemote, staleRemote, 'desktopSystemEnabled');
  assert.equal(afterFirstResponse.desktopSessionEndSoundEnabled, true);
});

test('浏览器权限能力与账号偏好分离', () => {
  assert.equal(getBrowserNotificationAvailability({ supported: false, permission: 'unsupported', accountEnabled: true }), 'enabled_unsupported');
  assert.equal(getBrowserNotificationAvailability({ supported: true, permission: 'denied', accountEnabled: true }), 'enabled_denied');
  assert.equal(getBrowserNotificationAvailability({ supported: true, permission: 'granted', accountEnabled: true }), 'available');
  assert.equal(getBrowserNotificationAvailability({ supported: true, permission: 'default', accountEnabled: true }), 'permission_required');
});

test('关闭通知是中性状态，仅已开启但不可用时告警', () => {
  assert.equal(getNotificationPermissionTone({ currentDevice: true, accountEnabled: false, permission: 'default' }), 'neutral');
  assert.equal(getNotificationPermissionTone({ currentDevice: false, accountEnabled: true, permission: 'denied' }), 'neutral');
  assert.equal(getNotificationPermissionTone({ currentDevice: true, accountEnabled: true, permission: 'default' }), 'warning');
  assert.equal(getNotificationPermissionTone({ currentDevice: true, accountEnabled: true, permission: 'denied' }), 'danger');
  assert.equal(getNotificationPermissionTone({ currentDevice: true, accountEnabled: true, permission: 'granted' }), 'success');
});
