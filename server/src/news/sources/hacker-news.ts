import type { SourceCandidate } from './source-types.js';

interface HackerNewsItem {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  url?: unknown;
  time?: unknown;
  deleted?: unknown;
  dead?: unknown;
  text?: unknown;
}

export function parseHackerNewsItem(value: HackerNewsItem, sourceId: string): SourceCandidate | null {
  if (value.type !== 'story' || value.deleted === true || value.dead === true || typeof value.id !== 'number' || typeof value.title !== 'string') return null;
  const rawUrl = typeof value.url === 'string' && value.url ? value.url : `https://news.ycombinator.com/item?id=${value.id}`;
  return {
    sourceId, rawUrl, baseUrl: 'https://news.ycombinator.com/', title: value.title.trim(),
    description: null, rawPublishedAt: typeof value.time === 'number' ? value.time : null,
  };
}
