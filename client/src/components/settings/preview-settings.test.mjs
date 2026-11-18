import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTsxForTest } from '../ui/tsx-test-helper.mjs';
const { default: PreviewSettings } = await loadTsxForTest(new URL('./PreviewSettings.tsx', import.meta.url).href, new Map([
  [new URL('../../auth/AuthContext.tsx', import.meta.url).href, 'export const useAuth = () => ({user: globalThis.previewTestUser});'],
  [new URL('../../stores/preview-preferences.ts', import.meta.url).href, 'export const usePreviewPreferences = () => globalThis.previewTestState; export const getEffectivePreviewPreferences = () => globalThis.previewTestEffective;'],
]));
import { PREVIEW_CAPACITY_PRESETS, PREVIEW_IMAGE_PRESETS } from '../../generated/relay-contracts.ts';
test('members see concrete preset values, while only administrators see bounded custom inputs', () => {
  globalThis.previewTestUser = { id: 'owner', role: 'member' };
  globalThis.previewTestState = { userId: 'owner', loaded: true, loading: false, saving: false, error: '', preferences: { capacityPreset: 'enhanced', imagePreset: 'default' } };
  globalThis.previewTestEffective = { capacity: PREVIEW_CAPACITY_PRESETS.enhanced, image: PREVIEW_IMAGE_PRESETS.default };
  const member = renderToStaticMarkup(React.createElement(PreviewSettings));
  assert.match(member, /仅对你的账号生效/); assert.match(member, /≤10 MB/); assert.match(member, /前100页或内容块/); assert.doesNotMatch(member, /自定义|type="number"/);
  globalThis.previewTestUser = { id: 'admin', role: 'admin' };
  globalThis.previewTestState = { ...globalThis.previewTestState, userId: 'admin', preferences: { capacityPreset: 'custom', imagePreset: 'custom' } };
  const admin = renderToStaticMarkup(React.createElement(PreviewSettings, { onClose() {} }));
  assert.match(admin, /自定义/); assert.equal((admin.match(/type="number"/g) || []).length, 7);
  assert.match(admin, /min="3" max="20"/); assert.match(admin, /关闭预览设置/);
  delete globalThis.previewTestState; delete globalThis.previewTestEffective; delete globalThis.previewTestUser;
});
