import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { getRequestActor, type Actor, type RelayEnv } from '../auth/authorization.js';
import { isAllowedOrigin } from '../security.js';
import { fetchSource } from '../news/sources/fetch-source.js';
import type { NewsSource, SourceFetchResult } from '../news/sources/source-types.js';
import type { NewsRepository } from '../news/storage/news-repository.js';
import type { NewsScheduler } from '../news/ingest/scheduler.js';
import { GlobalNewsPolicySchema, matchesGlobalBlock, validateSourceConfig } from '../news/policy/global-policy.js';
import { SOCIAL_PLATFORMS, validSocialUrl } from '../news/sources/social-platforms.js';
import { isLocalRsshubUrl } from '../news/sources/rsshub-local.js';
import { normalizeCandidate } from '../news/ingest/normalizer.js';
import { chooseEventId } from '../news/ingest/event-cluster.js';

const correctionSchema = z.object({
  hidden: z.boolean(), categoryId: z.string().regex(/^[a-z0-9_]{2,64}$/).optional(),
  topicIds: z.array(z.string().regex(/^[a-z0-9_]{2,64}$/)).max(16).optional(),
  entityIds: z.array(z.string().regex(/^[a-z0-9_]{2,64}$/)).max(16).optional(),
  eventTypeId: z.string().regex(/^[a-z0-9_]{2,64}$/).nullable().optional(),
}).strict();
type Repo = Pick<NewsRepository, 'getStatus' | 'getSourceState' | 'getSourceItemCounts' | 'listSources' | 'saveSource' | 'getGlobalPolicy' | 'saveGlobalPolicy' | 'list' | 'getCorrection' | 'listCorrections' | 'saveCorrection' | 'listCategories' | 'saveCategory' | 'listAudit' | 'recordAudit' | 'getStatistics' | 'upsertBatch' | 'hasItemId'>;

const socialItemSchema = z.object({
  platform: z.enum(['wechat', 'xiaohongshu', 'douyin', 'kuaishou', 'weibo']),
  url: z.string().url().max(2048),
  title: z.string().trim().min(2).max(300),
  description: z.string().trim().max(1000).optional(),
  author: z.string().trim().min(1).max(120),
  publishedAt: z.number().int(),
}).strict();

export function createNewsAdminRouter(options: {
  repository: () => Repo | null;
  scheduler?: () => Pick<NewsScheduler, 'replaceSources' | 'refreshSource' | 'status'> | null;
  getActor?: (context: Parameters<typeof getRequestActor>[0]) => Actor | Promise<Actor>;
  verifySource?: (source: NewsSource) => Promise<SourceFetchResult>;
  originAllowed?: (origin?: string | null) => boolean;
}) {
  const router = new Hono<RelayEnv>();
  const actor = async (c: Parameters<typeof getRequestActor>[0]) => {
    const current = await (options.getActor ?? getRequestActor)(c);
    if (current.role !== 'admin') throw new HTTPException(403, { message: '仅管理员可操作资讯配置' });
    return current;
  };
  const originAllowed = options.originAllowed ?? isAllowedOrigin;
  const verifySource = options.verifySource ?? ((source: NewsSource) => fetchSource({ ...source, enabled: true }, { signal: AbortSignal.timeout(isLocalRsshubUrl(source.url) ? 30_000 : 8_000) }));
  router.use('*', async (c, next) => {
    const current = await actor(c);
    if (current.role !== 'admin') return c.json({ error: '仅管理员可操作资讯配置' }, 403);
    if (!['GET', 'HEAD'].includes(c.req.method) && !originAllowed(c.req.header('origin'))) return c.json({ error: '不允许的请求来源' }, 403);
    if (!options.repository()?.getStatus().available) return c.json({ error: '资讯存储暂不可用' }, 503);
    c.header('Cache-Control', 'private, no-store');
    await next();
  });

  router.get('/sources', (c) => {
    const repo = options.repository()!;
    const counts = repo.getSourceItemCounts();
    return c.json({ sources: repo.listSources().map((source) => ({ ...source, state: repo.getSourceState(source.id), totalItemCount: counts[source.id] ?? 0 })) });
  });
  router.post('/sources/validate', async (c) => {
    try {
      const source = validateSourceConfig(await c.req.json());
      const result = await verifySource(source);
      return c.json({ valid: result.status === 'ok', status: result.status, sampleCount: result.candidates.length, sampleTitles: result.candidates.slice(0, 3).map((item) => item.title), error: result.error ?? null });
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : '来源配置无效' }, 400); }
  });
  const saveSource = async (c: Context<RelayEnv>, expectedId?: string) => {
    try {
      const source = validateSourceConfig(await c.req.json());
      if (source.id.startsWith('social-')) return c.json({ error: '社交平台来源标识由系统保留' }, 400);
      if (expectedId && expectedId !== source.id) return c.json({ error: '来源 ID 不可修改' }, 400);
      const repo = options.repository()!;
      if (!expectedId && repo.listSources().some((entry) => entry.id === source.id)) return c.json({ error: '来源 ID 已存在，请编辑该来源' }, 409);
      if (source.enabled) {
        const result = await verifySource(source);
        if (result.status !== 'ok') return c.json({ error: result.error ?? `来源验证失败：${result.status}` }, 422);
      }
      repo.saveSource(source, (await actor(c)).userId);
      options.scheduler?.()?.replaceSources(repo.listSources());
      return c.json({ source });
    } catch (error) { if (error instanceof HTTPException) throw error; return c.json({ error: error instanceof Error ? error.message : '来源配置无效' }, 400); }
  };
  router.post('/sources', (c) => saveSource(c));
  router.put('/sources/:id', (c) => saveSource(c, c.req.param('id')));
  router.post('/sources/:id/refresh', async (c) => {
    const current = await actor(c);
    const result = options.scheduler?.()?.refreshSource(c.req.param('id'), { id: current.userId, role: current.role }) ?? { accepted: false, reason: 'scheduler_unavailable' };
    if (result.accepted) options.repository()!.recordAudit(current.userId, 'source.refresh', { id: c.req.param('id') });
    return c.json(result, result.accepted ? 202 : 409);
  });

  router.post('/social-items', async (c) => {
    const parsed = socialItemSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '原帖信息不完整' }, 400);
    const input = parsed.data;
    const checkedAt = Date.now();
    if (!validSocialUrl(input.platform, input.url)) return c.json({ error: '请填写对应平台的公开 HTTPS 原帖链接' }, 400);
    if (input.publishedAt < checkedAt - 30 * 86_400_000 || input.publishedAt > checkedAt + 86_400_000) return c.json({ error: '原帖时间需在最近 30 天内' }, 400);
    const repo = options.repository()!;
    const id = `social-${input.platform}`;
    const item = normalizeCandidate({
      sourceId: id, rawUrl: input.url, baseUrl: input.url, title: input.title,
      description: input.description ?? null, rawPublishedAt: input.publishedAt,
      originalPublisher: input.author,
    }, { id, name: SOCIAL_PLATFORMS[input.platform].name, kind: 'rss_atom', url: input.url,
      allowedHosts: [new URL(input.url).hostname], enabled: false, intervalMinutes: 1440, categoryId: 'industry' }, checkedAt);
    if (repo.hasItemId(item.id, checkedAt - 30 * 86_400_000, checkedAt + 86_400_000)) return c.json({ itemId: item.id, inserted: false });
    const storage = repo.getStatistics();
    if (storage.freeBytes != null && storage.freeBytes < Math.max(256 * 1024 ** 2, storage.bytes * 2)) return c.json({ error: '资讯磁盘空间不足' }, 507);
    const page = await repo.list({ from: checkedAt - 72 * 60 * 60_000, to: checkedAt + 86_400_000, limit: 50 });
    item.eventId = chooseEventId(item, page.items.flatMap((event) => event.sources));
    const current = await actor(c);
    const result = await repo.upsertBatch({ sourceId: id, fetchedAt: checkedAt, nextFetchAt: checkedAt + 86_400_000, items: [item] });
    if (result.inserted) repo.recordAudit(current.userId, 'social-item.add', { id: item.id, platform: input.platform });
    return c.json({ itemId: item.id, inserted: result.inserted > 0 }, result.inserted ? 201 : 200);
  });

  router.get('/policy', (c) => c.json({ policy: options.repository()!.getGlobalPolicy() }));
  router.post('/policy/preview', async (c) => {
    const parsed = GlobalNewsPolicySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '规则无效' }, 400);
    const repo = options.repository()!;
    const now = Date.now();
    const matches: Array<{ id: string; title: string; reason: string }> = [];
    let cursor: string | undefined;
    let hasMore = false;
    for (let index = 0; index < 10 && matches.length < 100; index++) {
      const page = await repo.list({ from: now - 7 * 86_400_000, to: now, limit: 50, cursor });
      for (const event of page.items) {
        const reasons = event.sources.map((source) => matchesGlobalBlock(source, parsed.data));
        const reason = reasons.every(Boolean) ? reasons[0] : null;
        if (reason) matches.push({ id: event.id, title: event.title, reason });
        if (matches.length >= 100) break;
      }
      hasMore = Boolean(page.nextCursor);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return c.json({ matches, capped: matches.length >= 100 || hasMore });
  });
  router.put('/policy', async (c) => {
    const parsed = GlobalNewsPolicySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '规则无效' }, 400);
    options.repository()!.saveGlobalPolicy(parsed.data, (await actor(c)).userId);
    return c.json({ policy: parsed.data });
  });

  router.put('/items/:id', async (c) => {
    const parsed = correctionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !/^[a-f0-9]{32}$/.test(c.req.param('id'))) return c.json({ error: '纠错内容无效' }, 400);
    options.repository()!.saveCorrection(c.req.param('id'), parsed.data, (await actor(c)).userId);
    return c.json({ correction: parsed.data });
  });
  router.get('/items', async (c) => {
    const repo = options.repository()!;
    const now = Date.now();
    const page = await repo.list({ from: now - 7 * 86_400_000, to: now, limit: 50 });
    return c.json({ items: page.items.map((event) => ({ id: event.id, title: event.title, sourceId: event.sourceId, categoryId: event.categoryId, correction: repo.getCorrection(event.id) })), corrections: repo.listCorrections() });
  });
  router.get('/categories', (c) => c.json({ categories: options.repository()!.listCategories() }));
  router.put('/categories/:id', async (c) => {
    const id = c.req.param('id');
    const parsed = z.object({ label: z.string().trim().min(1).max(80) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!/^[a-z0-9_]{2,64}$/.test(id) || !parsed.success) return c.json({ error: '分类无效' }, 400);
    options.repository()!.saveCategory(id, parsed.data.label, (await actor(c)).userId);
    return c.json({ id, label: parsed.data.label });
  });
  router.get('/stats', (c) => {
    const repo = options.repository()!;
    return c.json({ status: repo.getStatus(), storage: repo.getStatistics(), scheduler: options.scheduler?.()?.status() ?? null, sources: repo.listSources().map((source) => ({ id: source.id, ...repo.getSourceState(source.id) })), audit: repo.listAudit(20) });
  });
  return router;
}
