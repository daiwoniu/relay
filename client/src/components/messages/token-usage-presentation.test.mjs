import assert from 'node:assert/strict';
import test from 'node:test';
import { getTokenUsagePresentation } from './token-usage-presentation.ts';

test('拆分本轮输出中的推理与非推理 Tokens', () => {
  assert.deepEqual(getTokenUsagePresentation({
    inputTokens: 126148,
    cachedInputTokens: 125440,
    outputTokens: 384,
    reasoningOutputTokens: 312,
    totalTokens: 126532,
    modelContextWindow: 200000,
  }), {
    outputTokens: 384,
    reasoningOutputTokens: 312,
    nonReasoningOutputTokens: 72,
  });
});

test('异常数据不会产生负的非推理输出', () => {
  const presentation = getTokenUsagePresentation({
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 25,
    totalTokens: 30,
    modelContextWindow: 100,
  });
  assert.equal(presentation.nonReasoningOutputTokens, 0);
});
