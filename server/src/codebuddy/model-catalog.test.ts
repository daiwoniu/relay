import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCodeBuddyModelCatalog } from './model-catalog.js';

test('CodeBuddy session 结果映射模型、费用、上下文和 thought_level 目录', () => {
  const catalog = parseCodeBuddyModelCatalog({
    sessionId: 'cb-1',
    models: { currentModelId: 'hy3', availableModels: [
      { modelId: 'hy3', name: '同名', description: 'x0.00 credits', _meta: { supportsImages: true, supportsReasoning: true, credits: 'x0.00 credits', maxInputTokens: 192000 } },
      { modelId: 'hy3-x', name: '同名', description: 'x1.00 credits', _meta: { supportsImages: false, supportsReasoning: true, credits: 'x1.00 credits', maxInputTokens: 256000 } },
    ] },
    configOptions: [{
      id: 'thought_level', category: 'thought_level', currentValue: 'enabled',
      options: [
        { value: 'low', name: 'Low', description: 'Light reasoning' },
        { value: 'enabled', name: 'On (default)', description: 'Model default' },
      ],
    }],
  }, { now: () => 123 });

  assert.equal(catalog.fetchedAt, 123);
  assert.deepEqual(catalog.models.map((model) => [model.id, model.displayName]), [['hy3', '同名'], ['hy3-x', '同名']]);
  assert.equal(catalog.models[0]?.isDefault, true);
  assert.equal(catalog.models[0]?.costLabel, 'x0.00 credits');
  assert.equal(catalog.models[1]?.costLabel, 'x1.00 credits');
  assert.equal(catalog.models[0]?.contextWindow, 192000);
  assert.deepEqual(catalog.models[1]?.inputModalities, ['text']);
  assert.equal(catalog.models[0]?.reasoning.defaultOptionId, 'enabled');
  assert.deepEqual(catalog.models[0]?.reasoning.options.map((option) => option.id), ['low', 'enabled']);
});

test('CodeBuddy session 结果携带布尔型 configOption 时仍正常映射目录', () => {
  const catalog = parseCodeBuddyModelCatalog({
    sessionId: 'cb-2',
    models: { currentModelId: 'hy3', availableModels: [
      { modelId: 'hy3', name: 'Hy3', _meta: { supportsReasoning: true } },
    ] },
    configOptions: [
      { id: 'thought_level', category: 'thought_level', currentValue: 'enabled', options: [{ value: 'enabled', name: 'On (default)' }] },
      { id: 'multitask', type: 'boolean', category: '_codebuddy.ai/multitask', currentValue: false },
    ],
  }, { now: () => 123 });

  assert.equal(catalog.models[0]?.reasoning.defaultOptionId, 'enabled');
  assert.deepEqual(catalog.models[0]?.reasoning.options.map((option) => option.id), ['enabled']);
});
