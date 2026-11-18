import { Hono, type Context } from 'hono';
import { getHttpClientIp } from '../http-client-ip.js';
import { PublicShareRateLimiter } from '../shares/public-rate-limit.js';
import { isAllowedOrigin } from '../security.js';
import { SEED_SOURCES } from '../news/sources/seed-sources.js';
import { socialSourceNames, sourceIdsForRegion } from '../news/sources/social-platforms.js';
import type { NewsRepository } from '../news/storage/news-repository.js';
import type { NewsFilters, NewsItemInput } from '../news/types.js';
import { matchesGlobalBlock } from '../news/policy/global-policy.js';
import { matchesVisibleFilters, shardFilters } from '../news/policy/visible-filters.js';

const DAY_MS = 86_400_000;
const limiter = new PublicShareRateLimiter(90);
type Repository = Pick<NewsRepository, 'getStatus' | 'getSourceState' | 'list'> & Partial<Pick<NewsRepository, 'getGlobalPolicy' | 'getCorrection' | 'listSources' | 'listCategories'>>;
const displayNames = new Map([...SEED_SOURCES.map((source): [string, string] => [source.id, source.name]), ...socialSourceNames()]);

export function publicItem(item: NewsItemInput, names: Map<string, string>) {
  return {
    id: item.id, eventId: item.eventId, sourceId: item.sourceId,
    sourceName: names.get(item.sourceId) ?? item.sourceId,
    url: item.url, title: item.title, description: item.description,
    publishedAt: item.publishedAt, categoryId: item.categoryId,
    topicIds: item.topicIds, entityIds: item.entityIds, eventTypeId: item.eventTypeId,
    language: item.language, originalPublisher: item.originalPublisher ?? null,
    timeIsFallback: Boolean(item.timeIsFallback),
  };
}

function intParam(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value)) throw new RangeError('无效的时间或条数');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError('无效的时间或条数');
  return parsed;
}

export function createPublicNewsRouter({ repository, now = Date.now, getClientId }: {
  repository: () => Repository | null;
  now?: () => number;
  getClientId?: (context: Context) => string;
}) {
  const router = new Hono();
  const cache = new Map<string, { until: number; body: unknown }>();
  router.use('*', async (c, next) => {
    if (!isAllowedOrigin(c.req.header('origin'))) return c.json({ error: '不允许的请求来源' }, 403);
    const client = getClientId?.(c) || getHttpClientIp(c);
    if (!limiter.consume(client.slice(0, 128))) return c.json({ error: '请求过于频繁' }, 429);
    c.header('Cache-Control', 'public, max-age=30');
    await next();
  });
  router.get('/version', (c) => {
    const repo = repository();
    const status = repo?.getStatus();
    if (!status?.available || !repo) return c.json({ error: '资讯暂时不可用' }, 503);
    return c.json({
      version: status.version,
      lastSuccessAt: status.lastSuccessAt,
      partialFailure: (repo.listSources?.() ?? SEED_SOURCES).some((source) => source.enabled && Boolean(repo.getSourceState(source.id)?.lastError)),
    });
  });
  router.get('/', async (c) => {
    const repo = repository();
    const status = repo?.getStatus();
    if (!status?.available || !repo) return c.json({ error: '资讯暂时不可用' }, 503);
    try {
      const to = intParam(c.req.query('to'), now());
      const from = intParam(c.req.query('from'), to - 2 * DAY_MS);
      const limit = intParam(c.req.query('limit'), 20);
      if (from > to || to - from > 31 * DAY_MS || to > now() + DAY_MS || limit < 1 || limit > 50) throw new RangeError('资讯查询范围无效');
      const filters: NewsFilters = {};
      for (const key of ['category', 'topic', 'entity', 'eventType', 'source', 'language', 'q'] as const) {
        const value = c.req.query(key)?.trim();
        if (!value) continue;
        if (value.length > (key === 'q' ? 120 : 80)) throw new RangeError('筛选条件过长');
        filters[key] = value;
      }
      const region = c.req.query('region');
      if (region === 'cn' || region === 'global') filters.sourceIds = sourceIdsForRegion(repo.listSources?.() ?? SEED_SOURCES, region);
      else if (region) throw new RangeError('资讯地区无效');
      const cursor = c.req.query('cursor');
      if (cursor) {
        try {
          const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
          if (!Array.isArray(decoded) || decoded.length !== 2 || !Number.isSafeInteger(decoded[0]) || typeof decoded[1] !== 'string') throw new Error();
        } catch { throw new RangeError('无效的资讯游标'); }
      }
      const policy = repo.getGlobalPolicy?.();
      const bucket = Math.floor(to / 30_000) * 30_000;
      const cacheKey = JSON.stringify([status.version, c.req.query('from') ? from : bucket - 2 * DAY_MS, c.req.query('to') ? to : bucket, limit, cursor, filters]);
      const cached = cache.get(cacheKey);
      if (cached && cached.until > now()) return c.json(cached.body);
      const names = new Map(displayNames);
      for (const source of repo.listSources?.() ?? []) names.set(source.id, source.name);
      const visible: Awaited<ReturnType<NewsRepository['list']>>['items'] = [];
      let scanCursor = cursor;
      let nextCursor: string | null = null;
      let version = status.version;
      for (let scan = 0; scan < 5 && visible.length < limit; scan++) {
        const page = await repo.list({ from, to, limit: limit - visible.length, cursor: scanCursor, filters: shardFilters(filters) });
        version = page.version;
        for (const event of page.items) {
          const sources = event.sources.map((source) => ({ ...source, ...repo.getCorrection?.(source.id) }))
            .filter((source) => !source.hidden && !(policy && matchesGlobalBlock(source, policy)) && matchesVisibleFilters(source, filters));
          if (!sources.length) continue;
          const head = sources[0]!;
          visible.push({ ...head, sources, publishedAt: event.publishedAt });
          if (visible.length >= limit) break;
        }
        nextCursor = page.nextCursor;
        if (!nextCursor) break;
        scanCursor = nextCursor;
      }
      const body = {
        items: visible.map((item) => ({ ...publicItem(item, names), sources: item.sources.map((source) => publicItem(source, names)) })),
        nextCursor, version, lastSuccessAt: status.lastSuccessAt,
        categories: repo.listCategories?.() ?? [],
        sources: [...names].map(([id, name]) => ({ id, name })),
        partialFailure: (repo.listSources?.() ?? SEED_SOURCES).some((source) => source.enabled && Boolean(repo.getSourceState(source.id)?.lastError)),
      };
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(cacheKey, { until: now() + 30_000, body });
      return c.json(body);
    } catch (error) {
      if (error instanceof RangeError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });
  return router;
}
