import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTsxForTest } from '../ui/tsx-test-helper.mjs';

const { default: AccountModelSettings } = await loadTsxForTest(new URL('./AccountModelSettings.tsx', import.meta.url).href);
const model = { id: 'sol', displayName: 'Sol', isDefault: true, inputModalities: ['text'],
  reasoning: { supported: true, scope: 'model', defaultOptionId: 'medium', options: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }] },
  serviceTiers: [{ id: 'priority', label: 'Fast' }, { id: 'ultrafast', label: 'Ultrafast' }] };
const user = { id: 'u1', defaultEngine: 'codex', defaultModelId: 'sol', defaultReasoningEffort: 'high', defaultServiceTier: 'ultrafast' };
const render = (props = {}) => renderToStaticMarkup(React.createElement(AccountModelSettings, { user, models: [model], pending: false, unavailable: false, onApply() {}, ...props }));

test('账号模型设置复用滑杆、速度按钮及应用交互，嵌入时不重复面板标题', () => {
  const html = render();
  assert.match(html, /model-settings-panel--embedded/);
  assert.match(html, /type="range"[^>]*aria-label="推理强度"/);
  assert.match(html, /aria-valuetext="高 \(high\)"/);
  assert.match(html, /role="group" aria-label="速度"/);
  const selectedSpeed = html.match(/<button[^>]*aria-pressed="true"[\s\S]*?<\/button>/)?.[0] ?? '';
  assert.match(selectedSpeed, /极速（ultrafast）/);
  assert.equal((selectedSpeed.match(/<path /g) ?? []).length, 2);
  assert.match(html, /标准（default）/);
  assert.match(html, /快速（priority）/);
  assert.match(html, /极速（ultrafast）/);
  assert.match(html, />取消<\/button>/);
  assert.match(html, />应用<\/button>/);
  assert.doesNotMatch(html, /model-settings-header/);
});

test('目录不可用或保存中禁用整个编辑区域', () => {
  assert.match(render({ unavailable: true }), /<fieldset disabled=""/);
  assert.match(render({ pending: true }), /<fieldset disabled=""/);
  assert.match(render({ pending: true }), /应用中…/);
});

test('不支持能力的引擎不显示速度档位，过期偏好提示清理', () => {
  const html = render({ models: [{ ...model, reasoning: { supported: false, options: [] }, serviceTiers: [] }] });
  assert.doesNotMatch(html, /type="range"|aria-label="速度"/);
  assert.match(html, /已保存的部分选项不再可用/);
  assert.match(render({ user: { ...user, defaultModelId: null, defaultReasoningEffort: null } }), /自动选择具体模型时，将使用该模型的默认推理强度/);
});

test('失效模型保留不可用提示，不冒用默认模型的能力', () => {
  const html = render({ user: { ...user, defaultModelId: 'removed' } });
  assert.match(html, /<option value="removed" disabled="" selected="">不可用 · removed/);
  assert.doesNotMatch(html, /type="range"|aria-label="速度"/);
});
