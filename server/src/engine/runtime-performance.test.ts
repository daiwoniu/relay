import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePerformanceStartedAt } from './runtime-performance.js';

test('普通回合沿用 dispatch 时间，重启恢复从本次连接开始计时', () => {
  assert.equal(resolvePerformanceStartedAt({ isRecovering: false, turnStartTime: 100 }, 500), 100);
  assert.equal(resolvePerformanceStartedAt({ isRecovering: true, turnStartTime: 100 }, 500), 500);
  assert.equal(resolvePerformanceStartedAt({ isRecovering: false, turnStartTime: null }, 500), 500);
});
