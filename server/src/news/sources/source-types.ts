export type NewsSourceKind = 'rss_atom' | 'github_releases' | 'hacker_news';

export interface NewsSource {
  id: string;
  name: string;
  kind: NewsSourceKind;
  url: string;
  allowedHosts: string[];
  enabled: boolean;
  intervalMinutes: number;
  categoryId: string;
  region?: 'cn' | 'global';
  disabledReason?: string;
}

export interface SourceCandidate {
  sourceId: string;
  rawUrl: string;
  baseUrl: string;
  title: string;
  description: string | null;
  rawPublishedAt: string | number | null;
  originalPublisher?: string | null;
}

export interface SourceFetchResult {
  status: 'ok' | 'not_modified' | 'rate_limited' | 'failed';
  candidates: SourceCandidate[];
  etag: string | null;
  lastModified: string | null;
  retryAfterMs?: number;
  partial?: boolean;
  error?: string;
}
