import { Hono } from 'hono';
import { getRequestActor, type Actor, type RelayEnv } from '../auth/authorization.js';
import { isAllowedOrigin } from '../security.js';
import type { NewsRepository } from '../news/storage/news-repository.js';
import type { NewsFilters, NewsItemInput } from '../news/types.js';
import { PersonalNewsPreferencesSchema, matchesPersonalRule, personalDecision } from '../news/policy/personal-policy.js';
import { matchesGlobalBlock } from '../news/policy/global-policy.js';
import { matchesVisibleFilters, shardFilters } from '../news/policy/visible-filters.js';
import { publicItem } from './news-public.js';
import { socialSourceNames, sourceIdsForRegion } from '../news/sources/social-platforms.js';

type Repo = Pick<NewsRepository, 'getStatus' | 'getUserPreferences' | 'saveUserPreferences' | 'getGlobalPolicy' | 'getCorrection' | 'listSources' | 'listCategories' | 'getSourceState' | 'list'>;
const DAY_MS = 86_400_000;

export function createNewsPreferencesRouter(options: {
  repository: () => Repo | null;
  getActor?: (context: Parameters<typeof getRequestActor>[0]) => Actor | Promise<Actor>;
  originAllowed?: (origin?: string | null) => boolean;
  now?: () => number;
}) {
  const router = new Hono<RelayEnv>();
  const actor = options.getActor ?? getRequestActor;
  const now = options.now ?? Date.now;
  const matchCache = new Map<string, { until: number; body: { counts: Record<string, number>; sampled: number; truncated: boolean } }>();
  router.use('*', async (c, next) => {
    await actor(c);
    if (c.req.method !== 'GET' && !(options.originAllowed ?? isAllowedOrigin)(c.req.header('origin'))) return c.json({ error: '不允许的请求来源' }, 403);
    if (!options.repository()?.getStatus().available) return c.json({ error: '资讯暂时不可用' }, 503);
    c.header('Cache-Control', 'private, no-store');
    await next();
  });
  router.get('/preferences', async (c) => c.json(options.repository()!.getUserPreferences((await actor(c)).userId)));
  router.get('/preferences/matches', async (c) => {
    const repo = options.repository()!;
    const current = await actor(c);
    const rules = repo.getUserPreferences(current.userId).rules;
    const cacheKey = JSON.stringify([current.userId, repo.getStatus().version, rules]);
    const cached = matchCache.get(cacheKey);
    if (cached && cached.until > now()) return c.json(cached.body);
    const counts = Object.fromEntries(rules.map((rule) => [rule.id, 0]));
    if (!rules.length) return c.json({ counts, sampled: 0, truncated: false });
    const policy = repo.getGlobalPolicy();
    const end = now();
    let cursor: string | undefined;
    let sampled = 0;
    for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
      const page = await repo.list({ from: end - 2 * DAY_MS, to: end, limit: 50, cursor });
      for (const event of page.items) {
        sampled++;
        const sources = event.sources.map((source) => ({ ...source, ...repo.getCorrection(source.id) }))
          .filter((source) => !source.hidden && !matchesGlobalBlock(source, policy));
        for (const rule of rules) if (sources.some((source) => matchesPersonalRule(source, rule))) counts[rule.id]++;
      }
      if (!page.nextCursor) {
        const body = { counts, sampled, truncated: false };
        if (matchCache.size >= 100) matchCache.delete(matchCache.keys().next().value!);
        matchCache.set(cacheKey, { until: now() + 60_000, body });
        return c.json(body);
      }
      cursor = page.nextCursor;
    }
    const body = { counts, sampled, truncated: true };
    if (matchCache.size >= 100) matchCache.delete(matchCache.keys().next().value!);
    matchCache.set(cacheKey, { until: now() + 60_000, body });
    return c.json(body);
  });
  router.put('/preferences', async (c) => {
    const parsed = PersonalNewsPreferencesSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '关注规则无效' }, 400);
    if (new Set(parsed.data.rules.map((rule) => rule.id)).size !== parsed.data.rules.length) return c.json({ error: '规则 ID 重复' }, 400);
    options.repository()!.saveUserPreferences((await actor(c)).userId, parsed.data);
    return c.json(parsed.data);
  });
  router.get('/', async (c) => {
    const repo = options.repository()!;
    try {
      const end = c.req.query('to') ? Number(c.req.query('to')) : now();
      const start = c.req.query('from') ? Number(c.req.query('from')) : end - 2 * DAY_MS;
      const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 20;
      if (![start, end, limit].every(Number.isSafeInteger) || start > end || end - start > 31 * DAY_MS || end > now() + DAY_MS || limit < 1 || limit > 50) throw new RangeError('资讯查询范围无效');
      const view = c.req.query('view') ?? 'all';
      if (view !== 'all' && view !== 'following') throw new RangeError('资讯视图无效');
      const filters: NewsFilters = {};
      for (const key of ['category', 'topic', 'entity', 'eventType', 'source', 'language', 'q'] as const) {
        const value = c.req.query(key)?.trim();
        if (!value) continue;
        if (value.length > (key === 'q' ? 120 : 80)) throw new RangeError('筛选条件过长');
        filters[key] = value;
      }
      const region = c.req.query('region');
      if (region === 'cn' || region === 'global') filters.sourceIds = sourceIdsForRegion(repo.listSources(), region);
      else if (region) throw new RangeError('资讯地区无效');
      const preferences = repo.getUserPreferences((await actor(c)).userId);
      const hasFollowRules = preferences.rules.some((rule) => rule.kind === 'follow');
      const policy = repo.getGlobalPolicy();
      const names = new Map([...repo.listSources().map((source): [string, string] => [source.id, source.name]), ...socialSourceNames()]);
      const visible: Array<{ head: NewsItemInput; sources: NewsItemInput[]; matchReason: string | null }> = [];
      let scanCursor = c.req.query('cursor');
      let nextCursor: string | null = null;
      let version = repo.getStatus().version;
      if (view !== 'following' || hasFollowRules) for (let scan = 0; scan < 5 && visible.length < limit; scan++) {
        const page = await repo.list({ from: start, to: end, limit: limit - visible.length, cursor: scanCursor, filters: shardFilters(filters) });
        version = page.version;
        for (const event of page.items) {
          const sources = event.sources.map((source) => ({ ...source, ...repo.getCorrection(source.id) })).filter((source) => {
            if (source.hidden || matchesGlobalBlock(source, policy) || !matchesVisibleFilters(source, filters)) return false;
            const decision = personalDecision(source, preferences);
            return !decision.muted && (view === 'all' || decision.followed);
          });
          if (!sources.length) continue;
          const head = { ...sources[0]!, publishedAt: event.publishedAt };
          visible.push({ head, sources, matchReason: personalDecision(head, preferences).reason });
        }
        nextCursor = page.nextCursor;
        if (!nextCursor) break;
        scanCursor = nextCursor;
      }
      const status = repo.getStatus();
      return c.json({
        items: visible.map(({ head, sources, matchReason }) => ({ ...publicItem(head, names), sources: sources.map((source) => publicItem(source, names)), matchReason })),
        nextCursor, version, lastSuccessAt: status.lastSuccessAt,
        partialFailure: repo.listSources().some((source) => source.enabled && Boolean(repo.getSourceState(source.id)?.lastError)),
        categories: repo.listCategories(), sources: [...names].map(([id, name]) => ({ id, name })), hasFollowRules,
      });
    } catch (error) {
      if (error instanceof RangeError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });
  return router;
}
