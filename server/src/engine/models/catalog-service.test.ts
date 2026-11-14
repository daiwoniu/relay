import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineAdapter } from '../adapter.js';
import { EngineRegistry } from '../registry.js';
import { EngineModelCatalogError, EngineModelCatalogService } from './catalog-service.js';
import type { EngineModelCatalog } from './types.js';
import { buildStoredTurnModelSnapshot } from './stored-turn-snapshot.js';
import { validateEnginePreferences } from './preferences.js';

function catalog(modelId = 'model-1'): EngineModelCatalog {
  return {
    engineId: 'codex', fetchedAt: 10, stale: false,
    models: [{
      id: modelId, displayName: '同名模型', isDefault: true, inputModalities: ['text'],
      reasoning: { supported: true, scope: 'model', defaultOptionId: 'medium', options: [{ id: 'medium', label: '中等' }] },
    }],
  };
}

function createService(listModels: () => Promise<EngineModelCatalog>, now: () => number = () => 1_000) {
  const adapter = { id: 'codex', models: { listModels } } as EngineAdapter;
  return new EngineModelCatalogService(new EngineRegistry([adapter]), { now });
}

test('模型目录在五分钟内缓存且并发请求 singleflight', async () => {
  let calls = 0;
  let resolve!: (value: EngineModelCatalog) => void;
  const pending = new Promise<EngineModelCatalog>((done) => { resolve = done; });
  const service = createService(async () => { calls += 1; return pending; });

  const first = service.get('codex');
  const second = service.get('codex');
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve(catalog());
  assert.deepEqual(await first, await second);
  assert.equal((await service.get('codex')).models[0]?.id, 'model-1');
  assert.equal(calls, 1);
});

test('refresh 绕过 TTL 但共享刷新，请求失败时返回 stale 旧目录', async () => {
  let calls = 0;
  let fail = false;
  const service = createService(async () => {
    calls += 1;
    if (fail) throw new Error('temporary');
    return catalog(`model-${calls}`);
  });

  assert.equal((await service.get('codex')).models[0]?.id, 'model-1');
  const [refreshed, sameRefresh] = await Promise.all([
    service.get('codex', { refresh: true }),
    service.get('codex', { refresh: true }),
  ]);
  assert.equal(calls, 2);
  assert.deepEqual(refreshed, sameRefresh);
  fail = true;
  const stale = await service.get('codex', { refresh: true });
  assert.equal(stale.stale, true);
  assert.equal(stale.models[0]?.id, 'model-2');
});

test('无旧目录的发现失败返回稳定错误', async () => {
  const service = createService(async () => { throw new Error('secret transport failure'); });
  await assert.rejects(
    () => service.get('codex'),
    (error) => error instanceof EngineModelCatalogError && error.code === 'ENGINE_MODEL_CATALOG_UNAVAILABLE',
  );
});

test('目录拒绝私有字段、重复模型 ID 和重复 reasoning option，但允许同名展示模型', async () => {
  const duplicateDisplayName = catalog();
  duplicateDisplayName.models.push({ ...duplicateDisplayName.models[0]!, id: 'model-2', isDefault: false });
  assert.equal((await createService(async () => duplicateDisplayName).get('codex')).models.length, 2);

  const duplicateModel = catalog();
  duplicateModel.models.push({ ...duplicateModel.models[0]! });
  await assert.rejects(() => createService(async () => duplicateModel).get('codex'), /模型 ID 重复/);

  const duplicateOption = catalog();
  duplicateOption.models[0]!.reasoning.options.push({ id: 'medium', label: '重复' });
  await assert.rejects(() => createService(async () => duplicateOption).get('codex'), /推理选项 ID 重复/);

  const privateCatalog = { ...catalog(), endpoint: 'https://secret.example' } as EngineModelCatalog;
  await assert.rejects(() => createService(async () => privateCatalog).get('codex'), /目录无效/);
});

test('invalidate 清除指定引擎缓存', async () => {
  let calls = 0;
  const service = createService(async () => catalog(`model-${++calls}`));
  await service.get('codex');
  service.invalidate('codex');
  assert.equal((await service.get('codex')).models[0]?.id, 'model-2');
});

test('真实会话观察到的新目录可主动刷新共享缓存', async () => {
  let calls = 0;
  const service = createService(async () => { calls += 1; return catalog('initial'); });
  await service.get('codex');
  service.prime('codex', { ...catalog('observed'), fetchedAt: 9 });
  const observed = await service.get('codex');
  assert.equal(observed.fetchedAt, 9);
  assert.equal(observed.models[0]?.id, 'observed');
  assert.equal(calls, 1);
});

test('发送校验立即使用过期目录，合并后台刷新；实际调度仍等待新目录', async () => {
  let now = 1_000, calls = 0;
  let resolve!: (value: EngineModelCatalog) => void;
  const refresh = new Promise<EngineModelCatalog>(done => { resolve = done; });
  const service = createService(async () => ++calls === 1 ? catalog('known') : refresh, () => now);
  await service.get('codex');
  now += 300_001;
  let admitted = false;
  const admission = service.get('codex', { preferCached: true }).then(value => { admitted = true; return value; });
  await Promise.resolve();
  assert.equal(admitted, true, 'provider discovery must not block cached admission');
  assert.equal((await admission).stale, true);
  assert.equal((await service.get('codex', { preferCached: true })).models[0]?.id, 'known');
  assert.equal(calls, 2);
  let dispatched = false;
  const dispatch = service.get('codex').then(value => { dispatched = true; return value; });
  await Promise.resolve();
  assert.equal(dispatched, false);
  resolve(catalog('updated'));
  assert.equal((await dispatch).models[0]?.id, 'updated');
  assert.equal((await service.get('codex', { preferCached: true })).stale, false);
});

test('发送没有已知目录时仍等待验证，显式刷新也不会被缓存优先选项绕过', async () => {
  let resolve!: (value: EngineModelCatalog) => void;
  let settled = false;
  const pending = new Promise<EngineModelCatalog>(done => { resolve = done; });
  const service = createService(async () => pending);
  const cold = service.get('codex', { preferCached: true }).then(value => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  resolve(catalog()); await cold;
  let calls = 0;
  const explicit = createService(async () => catalog(`model-${++calls}`));
  await explicit.get('codex');
  assert.equal((await explicit.get('codex', { preferCached: true, refresh: true })).models[0]?.id, 'model-2');
});

test('后台刷新失败限频，不随每次发送重试；显式刷新不受限频影响', async () => {
  let now = 1_000, calls = 0;
  let reject!: (error: Error) => void;
  const failure = new Promise<EngineModelCatalog>((_resolve, fail) => { reject = fail; });
  const service = createService(async () => ++calls === 1 ? catalog() : failure, () => now);
  await service.get('codex'); now += 300_001;
  await service.get('codex', { preferCached: true });
  const refresh = service.get('codex');
  reject(new Error('synthetic discovery failure')); await refresh;
  await service.get('codex', { preferCached: true });
  assert.equal(calls, 2);
  await service.get('codex', { refresh: true }); assert.equal(calls, 3);
  now += 30_001;
  await service.get('codex', { preferCached: true });
  assert.equal(calls, 4);
  await service.get('codex');
});

test('适配器同步抛错也会清除刷新占用，冷却后可以重新发现', async () => {
  let now = 1_000, calls = 0, fail = false;
  const service = createService(() => {
    calls += 1;
    if (fail) throw new Error('synchronous provider failure');
    return Promise.resolve(catalog());
  }, () => now);
  await service.get('codex'); now += 300_001; fail = true;
  await service.get('codex', { preferCached: true });
  assert.equal(calls, 2);
  now += 30_001; fail = false;
  await service.get('codex', { preferCached: true });
  assert.equal((await service.get('codex')).stale, false);
  assert.equal(calls, 3, 'failed refresh must not leave a permanently occupied in-flight promise');
});

test('缓存受理不绕过调度时的模型移除和默认配置校验', async () => {
  let now = 1_000;
  const service = createService(async () => catalog('replacement'), () => now);
  service.prime('codex', catalog('known')); now += 300_001;
  const preferences = { modelId: 'known', reasoningEffort: 'medium', serviceTier: null };
  const acceptedCatalog = await service.get('codex', { preferCached: true });
  assert.doesNotThrow(() => validateEnginePreferences(acceptedCatalog, preferences));
  const dispatchCatalog = await service.get('codex');
  assert.throws(() => validateEnginePreferences(dispatchCatalog, preferences), { code: 'ENGINE_MODEL_NOT_AVAILABLE' });

  const failing = createService(async () => { throw new Error('provider unavailable'); }, () => now);
  failing.prime('codex', { ...catalog(), configurationRead: true }); now += 300_001;
  await failing.get('codex', { preferCached: true });
  const stale = await failing.get('codex');
  assert.throws(() => buildStoredTurnModelSnapshot('codex', { modelId: null, reasoningEffort: null, serviceTier: null }, stale), /无法确认本轮默认配置/);
});
