import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultEngineSystem } from '../engine/default-system.js';
import { loadTurnModelCatalogSnapshot, validateSendEnginePreferences } from './frontend-model-selection.js';

test('自动配置开轮时刷新 Codex 目录并固定当时的默认档位', async (t) => {
  const originalGet = defaultEngineSystem.modelCatalog.get;
  let refreshed = false;
  defaultEngineSystem.modelCatalog.get = async (_engineId, options) => {
    refreshed = options?.refresh === true;
    return {
      engineId: 'codex', fetchedAt: 1, stale: false, configurationRead: true,
      models: [{
        id: 'gpt-current', displayName: 'GPT Current', isDefault: true, inputModalities: ['text'],
        defaultServiceTier: 'priority', serviceTiers: [{ id: 'priority', label: 'Fast' }],
        reasoning: { supported: true, scope: 'session', defaultOptionId: 'high', options: [{ id: 'high', label: 'High' }] },
      }],
    };
  };
  t.after(() => { defaultEngineSystem.modelCatalog.get = originalGet; });
  const snapshot = await loadTurnModelCatalogSnapshot('codex', { modelId: null, reasoningEffort: null, serviceTier: null });
  assert.equal(refreshed, true);
  assert.equal(snapshot.defaultModelId, 'gpt-current');
  assert.deepEqual(snapshot.modelDefaults['gpt-current'], { reasoningEffort: 'high', serviceTier: 'priority' });
});

test('配置的模型不在可见目录时仍使用配置模型而非目录推荐模型', async (t) => {
  const originalGet = defaultEngineSystem.modelCatalog.get;
  defaultEngineSystem.modelCatalog.get = async () => ({
    engineId: 'codex', fetchedAt: 1, stale: false, configurationRead: true,
    configuredDefaults: { modelId: 'private-model', reasoningEffort: 'high', serviceTier: 'fast' },
    models: [{ id: 'recommended', displayName: 'Recommended', isDefault: true, inputModalities: ['text'], reasoning: { supported: false, scope: 'session', options: [] } }],
  });
  t.after(() => { defaultEngineSystem.modelCatalog.get = originalGet; });
  const snapshot = await loadTurnModelCatalogSnapshot('codex', { modelId: null, reasoningEffort: null, serviceTier: null });
  assert.equal(snapshot.defaultModelId, 'private-model');
  assert.deepEqual(snapshot.modelDefaults['private-model'], { reasoningEffort: 'high', serviceTier: 'fast' });
});

test('依赖默认值时目录刷新失败不使用旧目录推断本轮配置', async (t) => {
  const originalGet = defaultEngineSystem.modelCatalog.get;
  defaultEngineSystem.modelCatalog.get = async () => ({ engineId: 'codex', fetchedAt: 1, stale: true, models: [] });
  t.after(() => { defaultEngineSystem.modelCatalog.get = originalGet; });
  await assert.rejects(
    loadTurnModelCatalogSnapshot('codex', { modelId: null, reasoningEffort: null, serviceTier: null }),
    /无法确认本轮默认配置/,
  );
});

test('依赖默认值时配置读取失败或无默认模型都不发送猜测值', async (t) => {
  const originalGet = defaultEngineSystem.modelCatalog.get;
  let configurationRead = false;
  defaultEngineSystem.modelCatalog.get = async () => ({
    engineId: 'codex', fetchedAt: 1, stale: false, configurationRead,
    models: [{ id: 'recommended', displayName: 'Recommended', isDefault: configurationRead ? false : true, inputModalities: ['text'], reasoning: { supported: false, scope: 'session', options: [] } }],
  });
  t.after(() => { defaultEngineSystem.modelCatalog.get = originalGet; });
  const preferences = { modelId: null, reasoningEffort: null, serviceTier: null };
  await assert.rejects(loadTurnModelCatalogSnapshot('codex', preferences), /无法确认本轮默认配置/);
  configurationRead = true;
  await assert.rejects(loadTurnModelCatalogSnapshot('codex', preferences), /无法确认本轮默认模型/);
});

test('首次发送自动选模时仍校验速度能力', async (t) => {
  const originalGet = defaultEngineSystem.modelCatalog.get;
  defaultEngineSystem.modelCatalog.get = async () => ({
    engineId: 'codebuddy', fetchedAt: 1, stale: false,
    models: [{
      id: 'default-model', displayName: 'Default', isDefault: true, inputModalities: ['text'],
      reasoning: { supported: false, scope: 'session', options: [] },
    }],
  });
  t.after(() => { defaultEngineSystem.modelCatalog.get = originalGet; });

  await assert.rejects(
    validateSendEnginePreferences('codebuddy', { modelId: null, reasoningEffort: null, serviceTier: 'priority', expectedRevision: 0 }, false),
    /速度/,
  );
});
