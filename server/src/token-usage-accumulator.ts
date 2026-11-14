import type { TokenUsageDto } from './contracts/index.js';

export function accumulateTurnOutputUsage(
  previousSnapshot: TokenUsageDto | null,
  accumulatedUsage: TokenUsageDto | null,
  nextSnapshot: TokenUsageDto,
): TokenUsageDto {
  if (!previousSnapshot || !accumulatedUsage) return { ...nextSnapshot };

  const switchedModelCall = nextSnapshot.inputTokens !== previousSnapshot.inputTokens
    || nextSnapshot.cachedInputTokens !== previousSnapshot.cachedInputTokens
    || nextSnapshot.outputTokens < previousSnapshot.outputTokens
    || nextSnapshot.reasoningOutputTokens < previousSnapshot.reasoningOutputTokens;
  const outputIncrement = switchedModelCall
    ? nextSnapshot.outputTokens
    : Math.max(0, nextSnapshot.outputTokens - previousSnapshot.outputTokens);
  const reasoningIncrement = switchedModelCall
    ? nextSnapshot.reasoningOutputTokens
    : Math.max(0, nextSnapshot.reasoningOutputTokens - previousSnapshot.reasoningOutputTokens);
  const outputTokens = accumulatedUsage.outputTokens + outputIncrement;
  const reasoningOutputTokens = Math.min(
    outputTokens,
    accumulatedUsage.reasoningOutputTokens + reasoningIncrement,
  );

  return {
    ...nextSnapshot,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: nextSnapshot.inputTokens + outputTokens,
  };
}
