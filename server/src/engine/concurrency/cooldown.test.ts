import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptCooldownProbe, computeOverloadCooldown, inspectCooldown } from './cooldown.js';

test('连续过载按 30、60、120 秒递增并尊重更长 retryAfter', () => {
  const first = computeOverloadCooldown('codex:default', null, 1_000, null);
  assert.equal(first.consecutiveOverloads, 1);
  assert.equal(first.cooldownUntil, 31_000);
  const second = computeOverloadCooldown('codex:default', first, 40_000, 90_000);
  assert.equal(second.consecutiveOverloads, 2);
  assert.equal(second.cooldownUntil, 130_000);
  const third = computeOverloadCooldown('codex:default', second, 150_000, 7_200_000);
  assert.equal(third.consecutiveOverloads, 3);
  assert.equal(third.cooldownUntil, 3_750_000);
});

test('冷却到期后只允许一个 probe，已有 probe 时继续等待', () => {
  const cooldown = computeOverloadCooldown('codex:default', null, 1_000, null);
  assert.deepEqual(inspectCooldown(cooldown, 10_000), { state: 'blocked', retryAfterMs: 21_000 });
  assert.deepEqual(inspectCooldown(cooldown, 31_000), { state: 'probe_required' });
  assert.deepEqual(inspectCooldown({ ...cooldown, probeAttemptId: 'attempt-1' }, 31_000), { state: 'probe_in_progress' });
  assert.deepEqual(inspectCooldown(null, 31_000), { state: 'open' });
});

test('只有匹配的 probe 接受后才清除冷却', () => {
  const cooldown = { ...computeOverloadCooldown('codex:default', null, 1_000, null), probeAttemptId: 'attempt-1' };
  assert.equal(acceptCooldownProbe(cooldown, 'attempt-2', 40_000), cooldown);
  assert.deepEqual(acceptCooldownProbe(cooldown, 'attempt-1', 40_000), {
    resourceKey: cooldown.resourceKey,
    consecutiveOverloads: 0,
    cooldownUntil: null,
    probeAttemptId: null,
    lastOverloadAt: cooldown.lastOverloadAt,
    lastSuccessAt: 40_000,
    updatedAt: 40_000,
  });
});
