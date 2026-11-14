import { safeFetch } from './safe-fetch.js';
import { parseRssAtom } from './rss-atom.js';
import { parseGithubReleases } from './github-releases.js';
import { parseHackerNewsItem } from './hacker-news.js';
import { fetchLocalRsshub, isLocalRsshubUrl } from './rsshub-local.js';
import type { NewsSource, SourceCandidate, SourceFetchResult } from './source-types.js';

export interface FetchSourceOptions {
  signal: AbortSignal;
  etag?: string;
  lastModified?: string;
}

export interface FetchSourceDependencies {
  fetch: typeof safeFetch;
  fetchLocal?: typeof fetchLocalRsshub;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 24 * 60 * 60_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 24 * 60 * 60_000)) : undefined;
}

export async function fetchSource(source: NewsSource, options: FetchSourceOptions, dependencies: FetchSourceDependencies = { fetch: safeFetch }): Promise<SourceFetchResult> {
  const empty = { candidates: [] as SourceCandidate[], etag: null, lastModified: null };
  if (!source.enabled) return { status: 'failed', ...empty, error: '来源已停用' };
  try {
    const response = isLocalRsshubUrl(source.url)
      ? await (dependencies.fetchLocal ?? fetchLocalRsshub)(source.url, options.signal)
      : await dependencies.fetch(source.url, {
        allowedHosts: source.allowedHosts, signal: options.signal, etag: options.etag, lastModified: options.lastModified,
      });
    const cache = { etag: response.headers.etag ?? null, lastModified: response.headers['last-modified'] ?? null };
    if (response.status === 304) return { status: 'not_modified', candidates: [], ...cache };
    if (response.status === 429) return { status: 'rate_limited', candidates: [], ...cache, retryAfterMs: retryAfterMs(response.headers['retry-after'] ?? null) };
    if (response.status < 200 || response.status >= 300) return { status: 'failed', candidates: [], ...cache, error: `HTTP ${response.status}` };
    const body = decoder.decode(response.body);
    if (source.kind === 'rss_atom') return { status: 'ok', candidates: parseRssAtom(body, source.id, source.url), ...cache };
    if (source.kind === 'github_releases') return { status: 'ok', candidates: parseGithubReleases(body, source.id, source.url), ...cache };
    if (source.kind === 'hacker_news') {
      const ids: unknown = JSON.parse(body);
      if (!Array.isArray(ids)) throw new TypeError('HN 故事列表不是数组');
      const selected = ids.filter((id): id is number => Number.isSafeInteger(id) && id > 0).slice(0, 20);
      const candidates: SourceCandidate[] = [];
      let successfulDetails = 0;
      for (let offset = 0; offset < selected.length; offset += 2) {
        const items = await Promise.all(selected.slice(offset, offset + 2).map(async (id) => {
          try {
            const detail = await dependencies.fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { allowedHosts: source.allowedHosts, signal: options.signal });
            if (detail.status !== 200) return null;
            const parsed: unknown = JSON.parse(decoder.decode(detail.body));
            successfulDetails += 1;
            return parsed && typeof parsed === 'object' ? parseHackerNewsItem(parsed, source.id) : null;
          } catch { return null; }
        }));
        for (const item of items) if (item) candidates.push(item);
      }
      if (selected.length && successfulDetails === 0) return { status: 'failed', candidates: [], ...cache, error: 'HN 故事详情均不可用' };
      return { status: 'ok', candidates, ...cache, partial: successfulDetails < selected.length };
    }
    return { status: 'failed', candidates: [], ...cache, error: '不支持的来源类型' };
  } catch (error) {
    return { status: 'failed', ...empty, error: error instanceof Error ? error.message : String(error) };
  }
}
