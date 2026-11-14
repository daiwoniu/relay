import { SEARCH_HISTORY_BATCH_SIZE } from './session-search-navigation.ts';

export interface SearchHistoryTarget {
  sessionId: string;
  messageId: string;
}

export type SearchHistoryLoadResult =
  | { status: 'idle' }
  | { status: 'loaded'; target: SearchHistoryTarget }
  | { status: 'missing'; target: SearchHistoryTarget };

export async function loadSearchHistoryUntilCurrentTarget<T extends { id: string }>({
  getTarget,
  getLoadedMessages,
  loadOlderMessages,
  prependMessages,
  batchSize = SEARCH_HISTORY_BATCH_SIZE,
}: {
  getTarget: () => SearchHistoryTarget | null;
  getLoadedMessages: (sessionId: string) => T[];
  loadOlderMessages: (sessionId: string, limit: number) => Promise<{ messages: T[]; hasMore: boolean }>;
  prependMessages: (sessionId: string, messages: T[]) => void;
  batchSize?: number;
}): Promise<SearchHistoryLoadResult> {
  while (true) {
    const target = getTarget();
    if (!target) return { status: 'idle' };

    const loadedMessages = getLoadedMessages(target.sessionId);
    const loadedIds = new Set(loadedMessages.map((message) => message.id));
    if (loadedIds.has(target.messageId)) return { status: 'loaded', target };

    const page = await loadOlderMessages(target.sessionId, batchSize);
    const olderMessages = page.messages;
    const latestTarget = getTarget();
    if (!latestTarget || latestTarget.sessionId !== target.sessionId) return { status: 'idle' };

    const newMessages = olderMessages.filter((message) => !loadedIds.has(message.id));
    if (newMessages.length > 0) prependMessages(target.sessionId, olderMessages);
    if (olderMessages.some((message) => message.id === latestTarget.messageId)) {
      return { status: 'loaded', target: latestTarget };
    }
    if (!page.hasMore || olderMessages.length === 0 || newMessages.length === 0) {
      return { status: 'missing', target: latestTarget };
    }
  }
}
