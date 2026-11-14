import type { NewsPublicPageDto, NewsVersionDto, NewsAdminSourcesDto, NewsSourceConfigDto, NewsGlobalPolicyDto, NewsPolicyPreviewDto, NewsPersonalPreferencesDto, NewsMemberPageDto } from '../generated/relay-contracts';
import { jsonBody, requestJson } from './client';

export interface NewsQuery {
  from?: number; to?: number; cursor?: string; limit?: number;
  category?: string; topic?: string; entity?: string; eventType?: string;
  source?: string; language?: string; q?: string;
  region?: 'cn' | 'global';
}

async function skipEmptyPages<T extends { items: unknown[]; nextCursor: string | null }>(
  query: NewsQuery, signal: AbortSignal | undefined, fetchPage: (query: NewsQuery, signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  let cursor = query.cursor;
  let page: T;
  for (let attempt = 0; attempt < 3; attempt++) {
    page = await fetchPage({ ...query, cursor }, signal);
    if (page.items.length || !page.nextCursor || attempt === 2) return page;
    cursor = page.nextCursor;
  }
  throw new Error('资讯分页状态异常');
}

function fetchPublicNewsPage(query: NewsQuery = {}, signal?: AbortSignal): Promise<NewsPublicPageDto> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
  return requestJson(`/api/public/news${params.size ? `?${params}` : ''}`, { signal, notifyUnauthorized: false, timeoutMs: 15_000 });
}

export function getPublicNews(query: NewsQuery = {}, signal?: AbortSignal): Promise<NewsPublicPageDto> {
  return skipEmptyPages(query, signal, fetchPublicNewsPage);
}

export function getPublicNewsVersion(signal?: AbortSignal): Promise<NewsVersionDto> {
  return requestJson('/api/public/news/version', { signal, notifyUnauthorized: false, timeoutMs: 8_000 });
}

function fetchMemberNewsPage(query: NewsQuery & { view?: 'all' | 'following' } = {}, signal?: AbortSignal): Promise<NewsMemberPageDto> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
  return requestJson(`/api/news${params.size ? `?${params}` : ''}`, { signal, timeoutMs: 15_000 });
}
export function getMemberNews(query: NewsQuery & { view?: 'all' | 'following' } = {}, signal?: AbortSignal): Promise<NewsMemberPageDto> {
  return skipEmptyPages(query, signal, fetchMemberNewsPage);
}
export function getNewsPreferences(): Promise<NewsPersonalPreferencesDto> { return requestJson('/api/news/preferences'); }
export interface NewsRuleMatchStats { counts: Record<string, number>; sampled: number; truncated: boolean }
export function getNewsRuleMatches(): Promise<NewsRuleMatchStats> { return requestJson('/api/news/preferences/matches'); }
export function saveNewsPreferences(preferences: NewsPersonalPreferencesDto): Promise<NewsPersonalPreferencesDto> {
  return requestJson('/api/news/preferences', { method: 'PUT', ...jsonBody(preferences) });
}

export function getAdminNewsSources(): Promise<NewsAdminSourcesDto> { return requestJson('/api/admin/news/sources'); }
export function verifyAdminNewsSource(source: NewsSourceConfigDto): Promise<{ valid: boolean; status: string; sampleCount: number; sampleTitles: string[]; error: string | null }> {
  return requestJson('/api/admin/news/sources/validate', { method: 'POST', ...jsonBody(source) });
}
export function saveAdminNewsSource(source: NewsSourceConfigDto, existing = false): Promise<{ source: NewsSourceConfigDto }> {
  return requestJson(`/api/admin/news/sources${existing ? `/${encodeURIComponent(source.id)}` : ''}`, { method: existing ? 'PUT' : 'POST', ...jsonBody(source) });
}
export function refreshAdminNewsSource(id: string): Promise<{ accepted: boolean; reason?: string }> {
  return requestJson(`/api/admin/news/sources/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
}
export interface NewsSocialItemInput {
  platform: 'wechat' | 'xiaohongshu' | 'douyin' | 'kuaishou' | 'weibo';
  url: string; title: string; description?: string; author: string; publishedAt: number;
}
export function addAdminNewsSocialItem(item: NewsSocialItemInput): Promise<{ itemId: string; inserted: boolean }> {
  return requestJson('/api/admin/news/social-items', { method: 'POST', ...jsonBody(item) });
}
export function getAdminNewsPolicy(): Promise<{ policy: NewsGlobalPolicyDto }> { return requestJson('/api/admin/news/policy'); }
export function previewAdminNewsPolicy(policy: NewsGlobalPolicyDto): Promise<NewsPolicyPreviewDto> {
  return requestJson('/api/admin/news/policy/preview', { method: 'POST', ...jsonBody(policy) });
}
export function saveAdminNewsPolicy(policy: NewsGlobalPolicyDto): Promise<{ policy: NewsGlobalPolicyDto }> {
  return requestJson('/api/admin/news/policy', { method: 'PUT', ...jsonBody(policy) });
}
export function saveAdminNewsCorrection(id: string, correction: { hidden: boolean; categoryId?: string; topicIds?: string[]; entityIds?: string[]; eventTypeId?: string | null }): Promise<unknown> {
  return requestJson(`/api/admin/news/items/${encodeURIComponent(id)}`, { method: 'PUT', ...jsonBody(correction) });
}
export function getAdminNewsCategories(): Promise<{ categories: Array<{ id: string; label: string }> }> { return requestJson('/api/admin/news/categories'); }
export function saveAdminNewsCategory(id: string, label: string): Promise<{ id: string; label: string }> {
  return requestJson(`/api/admin/news/categories/${encodeURIComponent(id)}`, { method: 'PUT', ...jsonBody({ label }) });
}
export interface NewsAdminStats { status: { version: number; lastSuccessAt: number | null; loadedShards: string[] }; storage: { itemCount: number; shardCount: number; bytes: number; freeBytes: number | null }; scheduler: { active: number } | null; sources: Array<{ id: string; lastError: string | null; lastDurationMs: number | null; lastFetchedCount: number | null }>; audit: Array<{ at: number; actorId: string; action: string }> }
export function getAdminNewsStats(): Promise<NewsAdminStats> { return requestJson('/api/admin/news/stats'); }
type NewsAdminCorrection = { hidden: boolean; categoryId?: string; topicIds?: string[]; entityIds?: string[]; eventTypeId?: string | null };
export interface NewsAdminItems { items: Array<{ id: string; title: string; sourceId: string; categoryId: string; correction: NewsAdminCorrection | null }>; corrections: Array<{ itemId: string; correction: NewsAdminCorrection }> }
export function getAdminNewsItems(): Promise<NewsAdminItems> { return requestJson('/api/admin/news/items'); }
