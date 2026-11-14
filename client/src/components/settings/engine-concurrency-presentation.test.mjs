import assert from 'node:assert/strict';
import test from 'node:test';
import { getEngineConcurrencyPresentation, isConcurrencyControlDisabled } from './engine-concurrency-presentation.ts';

test('不可用资源保持冷却状态，不伪装为空闲', () => {
  const result = getEngineConcurrencyPresentation({ resourceKey: 'codex:default', engineId: 'codex', label: 'Codex', maxActiveTurns: 2, activeTurns: 0, queuedTurns: 2, cooldownUntil: 50_000, probeInProgress: false, windows: [] }, 10_000);
  assert.equal(result.availabilityLabel, '冷却中');
  assert.equal(result.queueLabel, '2 个排队');
});

test('普通用户只读，管理员只锁正在保存的卡片', () => {
  assert.equal(isConcurrencyControlDisabled('member', 'a', []), true);
  assert.equal(isConcurrencyControlDisabled('admin', 'a', ['b']), false);
  assert.equal(isConcurrencyControlDisabled('admin', 'b', ['b']), true);
});

test('恢复探测与正常状态不会重复伪装成冷却', () => {
  const base = { resourceKey: 'codebuddy:default', engineId: 'codebuddy', label: 'CodeBuddy', maxActiveTurns: 4, activeTurns: 1, queuedTurns: 0, cooldownUntil: null, windows: [] };
  assert.equal(getEngineConcurrencyPresentation({ ...base, probeInProgress: true }, 10_000).availabilityLabel, '正在探测恢复');
  assert.equal(getEngineConcurrencyPresentation({ ...base, probeInProgress: false }, 10_000).availabilityLabel, '可调度');
});
