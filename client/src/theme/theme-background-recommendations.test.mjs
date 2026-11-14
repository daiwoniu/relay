import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRecommendedThemeBackground } from './theme-background-recommendations.ts';
import { createDefaultThemeProfile } from './theme-model.ts';

test('切换内置背景会应用该背景的推荐效果', () => {
  const profile = createDefaultThemeProfile();
  const dusk = applyRecommendedThemeBackground(profile, 'preset', 'dusk');
  assert.deepEqual({
    backgroundKind: dusk.backgroundKind,
    backgroundValue: dusk.backgroundValue,
    panelOpacity: dusk.panelOpacity,
    glassBlur: dusk.glassBlur,
    borderStrength: dusk.borderStrength,
  }, {
    backgroundKind: 'preset',
    backgroundValue: 'dusk',
    panelOpacity: 0.48,
    glassBlur: 14,
    borderStrength: 0.76,
  });
});

test('上传图片会应用通用推荐效果和图片默认构图', () => {
  const image = applyRecommendedThemeBackground(createDefaultThemeProfile(), 'asset', 'asset-1');
  assert.equal(image.panelOpacity, 0.52);
  assert.equal(image.overlayOpacity, 0.18);
  assert.equal(image.fit, 'cover');
  assert.equal(image.position, 'center');
});

test('重复选择当前背景不会覆盖用户手动调整', () => {
  const changed = { ...applyRecommendedThemeBackground(createDefaultThemeProfile(), 'preset', 'mist'), panelOpacity: 0.41 };
  assert.equal(applyRecommendedThemeBackground(changed, 'preset', 'mist'), changed);
});

test('选择无背景会恢复基础面板效果', () => {
  const current = applyRecommendedThemeBackground(createDefaultThemeProfile(), 'preset', 'ember');
  const none = applyRecommendedThemeBackground(current, 'none', null);
  assert.equal(none.panelOpacity, 1);
  assert.equal(none.glassBlur, 0);
  assert.equal(none.borderStrength, 0.55);
});
