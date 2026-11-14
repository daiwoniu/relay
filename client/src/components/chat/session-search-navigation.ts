// The message-page API accepts at most 100 messages per cursor request.
export const SEARCH_HISTORY_BATCH_SIZE = 100;
export const SEARCH_CONTEXT_BEFORE = 6;
export const SEARCH_CONTEXT_AFTER = 6;
export const DEFAULT_LATEST_MESSAGE_WINDOW_SIZE = 30;

export function getDefaultSearchMatchIndex(matchCount: number): number {
  return matchCount > 0 ? matchCount - 1 : -1;
}

export function getSearchNavigationPosition(
  currentIndex: number,
  loadedMatchCount: number,
  totalMatches: number,
): number {
  if (currentIndex < 0 || loadedMatchCount <= 0 || totalMatches <= 0) return 0;
  return Math.max(1, totalMatches - loadedMatchCount + currentIndex + 1);
}

export function moveSearchMatchIndex(
  currentIndex: number,
  matchCount: number,
  direction: 'previous' | 'next',
): number {
  if (matchCount <= 0) return -1;
  const normalizedIndex = Math.max(0, Math.min(matchCount - 1, currentIndex));
  return direction === 'previous'
    ? Math.max(0, normalizedIndex - 1)
    : Math.min(matchCount - 1, normalizedIndex + 1);
}

export function getNextSearchHistoryRequest(
  loadedMessageIds: ReadonlySet<string>,
  targetMessageId: string | null,
  loadedMessageCount: number,
  hasOlderMessages: boolean,
  batchSize = SEARCH_HISTORY_BATCH_SIZE,
): { limit: number; offset: number } | null {
  if (!targetMessageId || loadedMessageIds.has(targetMessageId) || !hasOlderMessages) return null;
  return {
    limit: batchSize,
    offset: loadedMessageCount,
  };
}

export function getSearchMessageWindowRange(
  targetIndex: number,
  messageCount: number,
  before = SEARCH_CONTEXT_BEFORE,
  _after = SEARCH_CONTEXT_AFTER,
): { start: number; end: number } {
  if (messageCount <= 0) return { start: 0, end: 0 };
  if (targetIndex < 0 || targetIndex >= messageCount) {
    return {
      start: Math.max(0, messageCount - DEFAULT_LATEST_MESSAGE_WINDOW_SIZE),
      end: messageCount,
    };
  }

  const start = Math.max(0, targetIndex - before);
  return {
    start,
    // Keep the loaded conversation tail visible in search mode. Otherwise the
    // scrollbar bottom represents only a tiny target window, not the latest
    // loaded message, and changing targets can fight with window replacement.
    end: messageCount,
  };
}
