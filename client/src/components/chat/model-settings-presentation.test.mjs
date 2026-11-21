import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModelChoices,
  formatContextWindow,
  formatReasoningEffortLabel,
  getModelPreferenceLabel,
  reconcileReasoningEffort,
  getServiceTierChoices,
  isAcceleratedServiceTier,
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
  assert.deepEqual(getServiceTierChoices(fastModel), [{ id: 'default', label: '标准（default）' }, { id: 'priority', label: '快速（priority）' }]);
  assert.equal(isAcceleratedServiceTier(fastModel, 'priority'), true);
  assert.equal(isAcceleratedServiceTier(fastModel, 'default'), false);
  assert.deepEqual(getServiceTierChoices(models[1]), []);
  assert.deepEqual(reconcileServiceTier(fastModel, 'priority'), { value: 'priority', changed: false });
  assert.deepEqual(reconcileServiceTier(models[1], 'priority'), { value: null, changed: true });
  assert.deepEqual(reconcileServiceTier(models[1], null), { value: null, changed: false });
});

test('Ultrafast 与后续目录档位可显示和保留，切换到不支持的模型才清空', () => {
  const sol = { ...models[0], defaultServiceTier: 'ultrafast', serviceTiers: [
    { id: 'priority', label: 'Fast' }, { id: 'ultrafast', label: 'Ultrafast' }, { id: 'future', label: 'Future tier' },
  ] };
  assert.deepEqual(getServiceTierChoices(sol), [
    { id: 'default', label: '标准（default）' }, { id: 'priority', label: '快速（priority）' },
    { id: 'ultrafast', label: '极速（ultrafast）' }, { id: 'future', label: 'Future tier（future）' },
  ]);
  assert.equal(isAcceleratedServiceTier(sol, 'ultrafast'), true);
  assert.deepEqual(reconcileServiceTier(sol, 'ultrafast'), { value: 'ultrafast', changed: false });
  assert.deepEqual(reconcileServiceTier({ ...sol, serviceTiers: [{ id: 'priority', label: 'Fast' }] }, 'ultrafast'), { value: null, changed: true });
  assert.deepEqual(reconcileServiceTier(sol, 'unknown'), { value: null, changed: true });
});
