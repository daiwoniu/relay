import type { TokenUsageDto } from '../../generated/relay-contracts';

export interface TokenUsagePresentation {
  outputTokens: number;
  reasoningOutputTokens: number;
  nonReasoningOutputTokens: number;
}

export function getTokenUsagePresentation(tokenUsage: TokenUsageDto): TokenUsagePresentation {
  return {
    outputTokens: tokenUsage.outputTokens,
    reasoningOutputTokens: tokenUsage.reasoningOutputTokens,
    nonReasoningOutputTokens: Math.max(0, tokenUsage.outputTokens - tokenUsage.reasoningOutputTokens),
  };
}
