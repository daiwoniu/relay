import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngineModelsRouter } from './engine-models.js';

const catalog = {
  engineId: 'codex' as const,
  fetchedAt: 1,
  stale: false,
  models: [],
};

test('模型目录接口返回私有非缓存响应并支持显式刷新', async () => {
  const calls: Array<{ engineId: string; refresh: boolean }> = [];
  const router = createEngineModelsRouter({
    getAvailability: () => ({ available: true }),
    getCatalog: async (engineId, options) => {
      calls.push({ engineId, refresh: options.refresh });
      return catalog;
    },
  });

  const response = await router.request('/engines/codex/models?refresh=1');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), catalog);
  assert.deepEqual(calls, [{ engineId: 'codex', refresh: true }]);
});

test('模型目录接口稳定区分未知、不可用和不支持目录', async () => {
  const router = createEngineModelsRouter({
    getAvailability: (engineId) => ({ available: engineId === 'codex' }),
    getCatalog: async () => {
      const error = new Error('不支持模型目录') as Error & { code: string };
      error.code = 'ENGINE_MODEL_CATALOG_UNSUPPORTED';
      throw error;
    },
  });

  assert.deepEqual(await (await router.request('/engines/unknown/models')).json(), {
    error: '未知的 AI 引擎', code: 'ENGINE_NOT_REGISTERED',
  });
  const unavailable = await router.request('/engines/codebuddy/models');
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json() as any).code, 'ENGINE_UNAVAILABLE');
  const opencodeUnavailable = await router.request('/engines/opencode/models');
  assert.equal(opencodeUnavailable.status, 503);
  assert.equal((await opencodeUnavailable.json() as any).code, 'ENGINE_UNAVAILABLE');
  const unsupported = await router.request('/engines/codex/models');
  assert.equal(unsupported.status, 501);
  assert.equal((await unsupported.json() as any).code, 'ENGINE_MODEL_CATALOG_UNSUPPORTED');
});
