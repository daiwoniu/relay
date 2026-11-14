import type { ProcessTimelineEntryDto } from '../generated/relay-contracts';

const PROCESS_TIMELINE_OPERATION_TYPES = new Set([
  'commandExecution', 'webSearch', 'fileChange', 'reasoning',
  'mcpToolCall', 'dynamicToolCall', 'plan', 'collabAgentToolCall',
  'subAgentActivity', 'imageGeneration',
  'interaction', 'systemNotice', 'contextCompaction',
  'imageView', 'hookPrompt', 'sleep', 'enteredReviewMode', 'exitedReviewMode',
]);

export function isProcessTimelineOperationType(type: string): boolean {
  return PROCESS_TIMELINE_OPERATION_TYPES.has(type);
}

export function appendNarrativeDelta(
  timeline: ProcessTimelineEntryDto[],
  itemId: string,
  content: string,
  firstObservedAt?: number,
): ProcessTimelineEntryDto[] {
  const index = timeline.findIndex((entry) => entry.type === 'narrative' && entry.itemId === itemId);
  if (index < 0) {
    const initialContent = content.startsWith('\n\n') ? content.slice(2) : content;
    return [...timeline, { type: 'narrative', itemId, content: initialContent, ...(firstObservedAt !== undefined ? { firstObservedAt } : {}) }];
  }

  const current = timeline[index];
  if (current.type !== 'narrative') return timeline;
  const next = [...timeline];
  next[index] = { ...current, content: current.content + content };
  return next;
}

export function insertOperationReference(
  timeline: ProcessTimelineEntryDto[],
  itemId: string,
): ProcessTimelineEntryDto[] {
  if (timeline.some((entry) => entry.type === 'operation' && entry.itemId === itemId)) return timeline;
  return [...timeline, { type: 'operation', itemId }];
}
