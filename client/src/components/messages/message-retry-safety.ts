interface RetryTraceItem {
  type: string;
}

const nonRetryableTraceItemTypes = new Set([
  'commandExecution',
  'fileChange',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageGeneration',
  'imageView',
  'mcpToolCall',
  'dynamicToolCall',
  'interaction',
]);

interface MessageRetrySafetyInput {
  finalContent: string;
  processContent?: string;
  items?: RetryTraceItem[];
  changedFileCount: number;
  processItemCount: number;
  processNarrativeCount: number;
  detailsLoaded: boolean;
}

export function isMessageSafeToRetry(input: MessageRetrySafetyInput): boolean {
  if (input.finalContent.trim() || input.processContent?.trim() || input.changedFileCount > 0) return false;
  if (!input.detailsLoaded && (input.processItemCount > 0 || input.processNarrativeCount > 0)) return false;
  return !(input.items || []).some((item) => nonRetryableTraceItemTypes.has(item.type));
}
