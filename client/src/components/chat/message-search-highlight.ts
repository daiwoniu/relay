export interface TextMatchOffset {
  start: number;
  end: number;
}

const SESSION_SEARCH_HIGHLIGHT_STYLE_ID = 'relay-session-search-highlight-style';

export function ensureSessionSearchHighlightStyle(): void {
  if (document.getElementById(SESSION_SEARCH_HIGHLIGHT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = SESSION_SEARCH_HIGHLIGHT_STYLE_ID;
  style.textContent = `
    ::highlight(relay-session-search-match) {
      background: color-mix(in srgb, var(--color-status-warning) 38%, transparent);
      color: var(--color-text);
      text-decoration: underline;
      text-decoration-color: var(--color-status-warning);
      text-decoration-thickness: 2px;
      text-underline-offset: 2px;
    }
  `;
  document.head.appendChild(style);
}

export function findCaseInsensitiveMatchOffsets(text: string, query: string): TextMatchOffset[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];

  const normalizedText = text.toLocaleLowerCase();
  const matches: TextMatchOffset[] = [];
  let searchFrom = 0;

  while (searchFrom <= normalizedText.length - normalizedQuery.length) {
    const start = normalizedText.indexOf(normalizedQuery, searchFrom);
    if (start < 0) break;
    matches.push({ start, end: start + normalizedQuery.length });
    searchFrom = start + normalizedQuery.length;
  }

  return matches;
}

export function getCenteredScrollTop(
  currentScrollTop: number,
  containerTop: number,
  containerHeight: number,
  matchTop: number,
  matchHeight: number,
): number {
  return Math.max(0, currentScrollTop + matchTop - containerTop - containerHeight / 2 + matchHeight / 2);
}

interface TextNodeSegment {
  node: Text;
  start: number;
  end: number;
}

export function createTextMatchRanges(root: HTMLElement, query: string): Range[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segments: TextNodeSegment[] = [];
  let text = '';
  let current = walker.nextNode();

  while (current) {
    const node = current as Text;
    const value = node.nodeValue ?? '';
    if (value) {
      const start = text.length;
      text += value;
      segments.push({ node, start, end: text.length });
    }
    current = walker.nextNode();
  }

  return findCaseInsensitiveMatchOffsets(text, query).flatMap((match) => {
    const startSegment = segments.find((segment) => match.start >= segment.start && match.start < segment.end);
    const endSegment = segments.find((segment) => match.end > segment.start && match.end <= segment.end);
    if (!startSegment || !endSegment) return [];

    const range = document.createRange();
    range.setStart(startSegment.node, match.start - startSegment.start);
    range.setEnd(endSegment.node, match.end - endSegment.start);
    return [range];
  });
}
