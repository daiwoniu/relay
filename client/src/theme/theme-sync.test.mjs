import assert from 'node:assert/strict';
import test from 'node:test';
import { publishThemeSettingsUpdate, subscribeThemeSettingsUpdates } from './theme-sync.ts';
import { createDefaultThemeSettings } from './theme-model.ts';

test('主题广播通过独立订阅器传递且支持取消订阅', () => {
  const received = [];
  const unsubscribe = subscribeThemeSettingsUpdates((settings) => received.push(settings));
  publishThemeSettingsUpdate(createDefaultThemeSettings('dark'));
  unsubscribe();
  publishThemeSettingsUpdate(createDefaultThemeSettings('light'));
  assert.equal(received.length, 1);
  assert.equal(received[0].basePreference, 'dark');
});
