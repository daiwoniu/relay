import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterEngineConcurrencyItems,
  getNextCooldownRefreshDelay,
  persistEngineConcurrencySetting,
  validateMaxActiveTurns,
} from './engine-concurrency-section-state.ts';

const windows = [5, 15, 60].map((windowMinutes) => ({
  windowMinutes,
  totalCount: 0,
  overloadCount: 0,
  requestRetryCount: 0,
  completionRetryCount: 0,
  cooldownCount: 0,
  startAcceptedCount: 0,
}));

const item = (engineId, label, cooldownUntil = null) => ({
  resourceKey: `${engineId}:${label.toLowerCase()}`,
  engineId,
  label,
  maxActiveTurns: 2,
  activeTurns: 0,
  queuedTurns: 0,
  cooldownUntil,
  probeInProgress: false,
  windows,
});

test('容量面板只展示当前引擎资源并按名称排序', () => {
  const result = filterEngineConcurrencyItems({
    z: item('codex', 'Zulu'),
    b: item('codebuddy', 'Beta'),
    a: item('codex', 'Alpha'),
  }, 'codex');
  assert.deepEqual(result.map((entry) => entry.label), ['Alpha', 'Zulu']);
});

test('冷却刷新只等待最近一个尚未到期的截止点', () => {
  assert.equal(getNextCooldownRefreshDelay([
    item('codex', 'A', 1_500),
    item('codex', 'B', 1_200),
    item('codex', 'C', 900),
  ], 1_000), 201);
  assert.equal(getNextCooldownRefreshDelay([item('codex', 'A', 900)], 1_000), null);
});

test('最大并发只接受 1–32 的整数', () => {
  assert.deepEqual(validateMaxActiveTurns('2'), { value: 2, error: null });
  for (const raw of ['', '0', '2.5', '33', 'abc']) {
    assert.deepEqual(validateMaxActiveTurns(raw), { value: null, error: '请输入 1–32 的整数' });
  }
});

test('保存逻辑返回更新结果并保留服务端错误', async () => {
  const calls = [];
  const updated = item('codex', 'Default');
  const success = await persistEngineConcurrencySetting('codex:default', '4', async (resourceKey, value) => {
    calls.push([resourceKey, value]);
    return { ...updated, maxActiveTurns: value };
  });
  assert.deepEqual(calls, [['codex:default', 4]]);
  assert.equal(success.item?.maxActiveTurns, 4);
  assert.equal(success.error, null);

  const invalid = await persistEngineConcurrencySetting('codex:default', '40', async () => {
    throw new Error('不应调用更新接口');
  });
  assert.deepEqual(invalid, { item: null, error: '请输入 1–32 的整数' });

  const failed = await persistEngineConcurrencySetting('codex:default', '3', async () => {
    throw new Error('服务暂不可用');
  });
  assert.deepEqual(failed, { item: null, error: '服务暂不可用' });
});
