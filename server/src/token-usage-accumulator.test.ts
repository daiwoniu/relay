import assert from 'node:assert/strict';
import test from 'node:test';
import { accumulateTurnOutputUsage } from './token-usage-accumulator.js';

const usage = (inputTokens: number, outputTokens: number, reasoningOutputTokens: number) => ({
  inputTokens,
  cachedInputTokens: inputTokens - 100,
  outputTokens,
  reasoningOutputTokens,
  totalTokens: inputTokens + outputTokens,
  modelContextWindow: 200000,
});

test('同一次模型调用只累计输出增长量', () => {
  const first = usage(1000, 120, 80);
  assert.deepEqual(
    accumulateTurnOutputUsage(first, first, usage(1000, 170, 110)),
    usage(1000, 170, 110),
  );
});

test('输入快照变化时将新模型调用输出加入本轮累计', () => {
  assert.deepEqual(
    accumulateTurnOutputUsage(usage(1000, 170, 110), usage(1000, 170, 110), usage(1400, 40, 25)),
    usage(1400, 210, 135),
  );
});

test('输出回落时即使输入相同也识别为新模型调用', () => {
  assert.equal(
    accumulateTurnOutputUsage(usage(1000, 170, 110), usage(1000, 250, 160), usage(1000, 30, 20)).outputTokens,
    280,
  );
});

test('重复快照不会重复累计', () => {
  assert.deepEqual(
    accumulateTurnOutputUsage(usage(1000, 170, 110), usage(1000, 250, 160), usage(1000, 170, 110)),
    usage(1000, 250, 160),
  );
});
