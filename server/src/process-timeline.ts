export type ProcessTimelineEntry =
  | { type: 'narrative'; itemId: string; content: string; firstObservedAt?: number }
  | { type: 'operation'; itemId: string };

export function appendNarrativeDelta(
  timeline: ProcessTimelineEntry[],
  itemId: string,
  content: string,
  firstObservedAt?: number,
): ProcessTimelineEntry[] {
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

export function removeNarrativeItem(
  timeline: ProcessTimelineEntry[],
  itemId: string,
): ProcessTimelineEntry[] {
  return timeline.filter((entry) => !(entry.type === 'narrative' && entry.itemId === itemId));
}

export function joinNarrativeContent(timeline: ProcessTimelineEntry[]): string {
  return timeline
    .filter((entry): entry is Extract<ProcessTimelineEntry, { type: 'narrative' }> => entry.type === 'narrative')
    .map((entry) => entry.content)
    .join('\n\n');
}

export function takeFinalAnswerFromTimeline(
  timeline: ProcessTimelineEntry[],
  finalAnswerItemId?: string | null,
): {
  processTimeline: ProcessTimelineEntry[];
  finalContent: string;
  processContent?: string;
} {
  if (!finalAnswerItemId) {
    return {
      processTimeline: timeline,
      finalContent: '',
      processContent: joinNarrativeContent(timeline) || undefined,
    };
  }
  const finalEntry = timeline.find((entry) => entry.type === 'narrative' && entry.itemId === finalAnswerItemId);
  const processTimeline = removeNarrativeItem(timeline, finalAnswerItemId);
  return {
    processTimeline,
    finalContent: finalEntry && finalEntry.type === 'narrative' ? finalEntry.content : '',
    processContent: joinNarrativeContent(processTimeline) || undefined,
  };
}

export function buildProcessTimelineFromTurnItems(
  items: Array<{ id: string; type: string; text?: unknown }>,
): ProcessTimelineEntry[] {
  let timeline: ProcessTimelineEntry[] = [];
  for (const item of items) {
    if (item.type === 'agentMessage') {
      if (typeof item.text === 'string' && item.text) {
        timeline = appendNarrativeDelta(timeline, item.id, item.text);
      }
      continue;
    }
    if (item.type === 'userMessage') continue;
    timeline = insertOperationReference(timeline, item.id);
  }
  return timeline;
}

export function insertOperationReference(
  timeline: ProcessTimelineEntry[],
  itemId: string,
): ProcessTimelineEntry[] {
  if (timeline.some((entry) => entry.type === 'operation' && entry.itemId === itemId)) return timeline;
  return [...timeline, { type: 'operation', itemId }];
}
