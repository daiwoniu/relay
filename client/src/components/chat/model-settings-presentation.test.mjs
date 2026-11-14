import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModelChoices,
  formatContextWindow,
  formatReasoningEffortLabel,
  getModelPreferenceLabel,
  reconcileReasoningEffort,
  getFastServiceTier,
  isFastServiceTier,
  reconcileServiceTier,
} from './model-settings-presentation.ts';

const models = [
  { id: 'alpha', displayName: 'Alpha', isDefault: false, inputModalities: ['text'], contextWindow: 128000, costLabel: '$$', reasoning: { supported: true, scope: 'model', defaultOptionId: 'medium', options: [{ id: 'low', label: '低' }, { id: 'medium', label: '中' }] } },
  { id: 'beta', displayName: 'Alpha', isDefault: true, inputModalities: ['text'], reasoning: { supported: false, scope: 'model', options: [] } },
];

test('concrete default choice stays first and catalog order is preserved', () => {
  const choices = buildModelChoices(models);
  assert.deepEqual(choices.map((choice) => choice.id), [null, 'alpha', 'beta']);
  assert.equal(choices[0].label, '跟随默认 · Alpha · beta');
  assert.equal(choices[0].model?.id, 'beta');
  assert.equal(choices[0].isDefault, true);
  assert.equal(choices[1].label, 'Alpha · alpha');
  assert.equal(choices[2].label, 'Alpha · beta');
  assert.equal(choices[2].isDefault, true);
});

test('context labels and reasoning fallback are deterministic', () => {
  assert.equal(formatContextWindow(128000), '128K 上下文');
  assert.deepEqual(reconcileReasoningEffort(models[0], null), { value: null, changed: false });
  assert.deepEqual(reconcileReasoningEffort(models[0], 'ultra'), { value: null, changed: true });
  assert.deepEqual(reconcileReasoningEffort(models[1], 'high'), { value: null, changed: true });
});

test('reasoning effort labels show canonical Chinese with the engine value', () => {
  assert.equal(formatReasoningEffortLabel('low', 'Low'), '低 (low)');
  assert.equal(formatReasoningEffortLabel('medium', '中'), '中等 (medium)');
  assert.equal(formatReasoningEffortLabel('high', 'High'), '高 (high)');
  assert.equal(formatReasoningEffortLabel('xhigh', 'Extra high'), '超高 (xhigh)');
  assert.equal(formatReasoningEffortLabel('max', 'Max'), '最高 (max)');
  assert.equal(formatReasoningEffortLabel('ultra', 'Ultra'), '极致 (ultra)');
  assert.equal(formatReasoningEffortLabel('custom', '自定义'), '自定义 (custom)');
  assert.equal(getModelPreferenceLabel('alpha', 'medium', models), 'Alpha · 中等');
});

test('速度仅随声明 Fast 档位的模型显示，换到普通模型会回退', () => {
  const fastModel = { ...models[0], serviceTiers: [{ id: 'priority', label: 'Fast' }] };
  assert.equal(getFastServiceTier(fastModel)?.id, 'priority');
  assert.equal(getFastServiceTier({ ...fastModel, defaultServiceTier: 'fast', serviceTiers: [
    { id: 'priority', label: 'Priority' }, { id: 'fast', label: 'Fast' },
  ] })?.id, 'fast');
  assert.equal(isFastServiceTier(fastModel, 'priority'), true);
  assert.equal(isFastServiceTier(fastModel, 'default'), false);
  assert.equal(getFastServiceTier(models[1]), null);
  assert.deepEqual(reconcileServiceTier(fastModel, 'priority'), { value: 'priority', changed: false });
  assert.deepEqual(reconcileServiceTier(models[1], 'priority'), { value: null, changed: true });
  assert.deepEqual(reconcileServiceTier(models[1], null), { value: null, changed: false });
});
