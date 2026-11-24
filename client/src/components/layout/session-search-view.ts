import type { MessageSearchSnippetDto, SessionSearchResultDto } from '../../generated/relay-contracts';

export interface HighlightedTextPart {
  text: string;
  highlighted: boolean;
}

export function buildHighlightedTextParts(text: string, query: string): HighlightedTextPart[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [{ text, highlighted: false }];

  const lowerText = text.toLowerCase();
  const lowerQuery = normalizedQuery.toLowerCase();
  const parts: HighlightedTextPart[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = lowerText.indexOf(lowerQuery, cursor);
    if (index < 0) {
      parts.push({ text: text.slice(cursor), highlighted: false });
      break;
    }
    if (index > cursor) parts.push({ text: text.slice(cursor, index), highlighted: false });
    parts.push({ text: text.slice(index, index + normalizedQuery.length), highlighted: true });
    cursor = index + normalizedQuery.length;
  }
  return parts.length > 0 ? parts : [{ text, highlighted: false }];
}

export function buildHighlightedTextPartsFromRange(
  text: string,
  matchStart: number,
  matchLength: number,
): HighlightedTextPart[] {
  if (matchStart < 0 || matchLength <= 0 || matchStart >= text.length) {
    return [{ text, highlighted: false }];
  }
  const matchEnd = Math.min(text.length, matchStart + matchLength);
  return [
    ...(matchStart > 0 ? [{ text: text.slice(0, matchStart), highlighted: false }] : []),
    { text: text.slice(matchStart, matchEnd), highlighted: true },
    ...(matchEnd < text.length ? [{ text: text.slice(matchEnd), highlighted: false }] : []),
  ];
}

export function getFallbackTitleMatches<T extends { title: string }>(sessions: T[], query: string): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return sessions;
  return sessions.filter((session) => session.title.toLowerCase().includes(normalizedQuery));
}

export const SIDEBAR_SEARCH_DEBOUNCE_MS = 250;

export function getSearchResultPresentation(result: Pick<
  SessionSearchResultDto,
  'messageMatchCount' | 'latestMessageMatch'
>): {
  showSummary: boolean;
  countLabel: string | null;
  snippet: MessageSearchSnippetDto | null;
} {
  if (result.messageMatchCount <= 0 || !result.latestMessageMatch) {
    return { showSummary: false, countLabel: null, snippet: null };
  }
  return {
    showSummary: true,
    countLabel: `消息 ${result.messageMatchCount} 处`,
    snippet: result.latestMessageMatch.snippet,
  };
}
