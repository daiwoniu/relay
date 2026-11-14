import assert from 'node:assert/strict';
import test from 'node:test';
import { validateEnginePreferences } from './preferences.js';

const catalog = {
  engineId: 'codex' as const,
  fetchedAt: 1,
  stale: false,
  models: [{
    id: 'fast-model', displayName: 'Fast', isDefault: true, inputModalities: ['text' as const],
    reasoning: { supported: false, scope: 'session' as const, options: [] },
    serviceTiers: [{ id: 'priority', label: 'Fast' }],
  }, {
    id: 'standard-model', displayName: 'Standard', isDefault: false, inputModalities: ['text' as const],
    reasoning: { supported: false, scope: 'session' as const, options: [] },
  }],
};

test('速度仅允许模型目录声明的档位，标准和继承始终可用', () => {
  assert.doesNotThrow(() => validateEnginePreferences(catalog, { modelId: 'fast-model', reasoningEffort: null, serviceTier: 'priority' }));
  assert.doesNotThrow(() => validateEnginePreferences(catalog, { modelId: 'fast-model', reasoningEffort: null, serviceTier: 'default' }));
  assert.doesNotThrow(() => validateEnginePreferences(catalog, { modelId: null, reasoningEffort: null, serviceTier: null }));
  assert.throws(() => validateEnginePreferences(catalog, { modelId: 'standard-model', reasoningEffort: null, serviceTier: 'priority' }), /速度/);
  assert.throws(() => validateEnginePreferences(catalog, { modelId: 'standard-model', reasoningEffort: null, serviceTier: 'default' }), /速度/);
  assert.throws(() => validateEnginePreferences(catalog, { modelId: null, reasoningEffort: null, serviceTier: 'unknown' }), /速度/);
});
