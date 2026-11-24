import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { presentApiError, SubAgentReportDtoSchema } from '../contracts/index.js';
import { readCodexSubAgentReport } from '../codex/thread-admin.js';
import { StorageContractError } from '../storage/command-boundary.js';
import type { CoreStoragePort, StorageRejectionCode } from '../storage/contracts.js';

const uuid = z.string().uuid();
const scope = z.enum(['mine','all']).optional();
const listing = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().nonnegative().max(100_000).optional(), afterId: z.string().max(256).optional(),
  projectId: uuid.optional(), scope }).strict().refine((v) => v.offset === undefined || v.afterId === undefined);
const messagePage = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30),
  knownRevision: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  beforeCreatedAt: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), beforeId: z.string().min(1).max(256).optional(),
}).strict().refine((v) => (v.beforeCreatedAt === undefined) === (v.beforeId === undefined));
const search = z.object({ q: z.string().trim().min(1).max(100), limit: z.coerce.number().int().min(1).max(100).default(50),
  scope, ownerUserId: z.string().min(1).max(256).optional() }).strict();
const messageSearch = z.object({ q: z.string().trim().min(1).max(100), limit: z.coerce.number().int().min(1).max(500).default(500),
  includeProcess: z.enum(['0','1']).optional(), includeOperations: z.enum(['0','1']).optional() }).strict();
const messageList = z.object({ limit: z.coerce.number().int().min(0).max(500).default(30),
  offset: z.coerce.number().int().nonnegative().max(100_000).default(0), details: z.enum(['0','1']).optional() }).strict();

/** Candidate public reads. Archive refresh must use the same native graph; no implicit engine or sql.js dependency. */
export function createStoredResourceReadsRouter(options: {
  port: CoreStoragePort; refreshSessionArchiveState: () => void | Promise<void>;
  loadSubAgentReport?: (childThreadId: string, completionItemId: string) => Promise<string | null>;
}) {
  options = Object.freeze({ ...options });
  const router = new Hono<RelayEnv>();
  const guard = createRequireStoredUserSession(options.port);
  for (const path of ['/projects', '/projects/:id', '/sessions', '/sessions/:id', '/sessions/:id/message-page', '/sessions/:id/messages/:messageId/details',
    '/sessions/:id/search-matches', '/sessions/:id/messages', '/sessions/:id/messages/:messageId/subagent-report', '/sessions/:id/deletion-impact', '/projects/:id/deletion-impact']) {
    router.use(path, guard, async (c, next) => { c.header('Cache-Control', 'private, no-store'); await next(); });
  }
  function failure(c: Context<RelayEnv>, code: StorageRejectionCode) {
    if (code === 'FORBIDDEN' || code === 'NOT_FOUND') return c.json(presentApiError('资源不存在'), 404);
    if (code === 'INVALID_ARGUMENT') return c.json(presentApiError('无效的查询参数'), 400);
    return c.json(presentApiError('资源读取暂不可用，请稍后刷新', { code: code === 'PAYLOAD_TOO_LARGE' ? code : 'STORAGE_UNAVAILABLE' }), 503);
  }
  router.onError((error, c) => failure(c, error instanceof StorageContractError ? error.code : 'STORAGE_UNAVAILABLE'));
  for (const kind of ['project', 'session'] as const) {
    router.get(`/${kind}s/:id/deletion-impact`, async (c) => {
      const id = uuid.safeParse(c.req.param('id'));
      if (!id.success || Object.keys(c.req.query()).length) return failure(c, 'INVALID_ARGUMENT');
      return c.json(await options.port.readDeletionImpact({ principal: c.get('relayStoragePrincipal')!, kind, resourceId: id.data }));
    });
  }
  router.get('/projects', async (c) => {
    const parsed = z.object({ scope }).strict().safeParse(c.req.query()); if (!parsed.success) return failure(c, 'INVALID_ARGUMENT');
    return c.json(await options.port.listProjects({ principal: c.get('relayStoragePrincipal')!,
      scope: parsed.data.scope ?? (c.get('relayActor').role === 'admin' ? 'all' : 'mine') }));
  });
  router.get('/projects/:id', async (c) => {
    const id = uuid.safeParse(c.req.param('id')); if (!id.success) return failure(c, 'INVALID_ARGUMENT');
    const project = await options.port.readProject({ principal: c.get('relayStoragePrincipal')!, projectId: id.data });
    return project ? c.json(project) : failure(c, 'NOT_FOUND');
  });
  router.get('/sessions', async (c) => {
    const parsed = listing.safeParse(c.req.query()); if (!parsed.success) return failure(c, 'INVALID_ARGUMENT');
    const v = parsed.data;
    if (!v.afterId) {
      try { await options.refreshSessionArchiveState(); } catch { console.warn('[Resources] 归档状态刷新暂不可用'); }
    }
    return c.json(await options.port.listSessionsOffset({ principal: c.get('relayStoragePrincipal')!,
      scope: v.scope ?? (c.get('relayActor').role === 'admin' ? 'all' : 'mine'), projectId: v.projectId ?? null,
      limit: v.limit, offset: v.offset ?? 0, ...(v.afterId === undefined ? {} : { afterId: v.afterId }) }));
  });
  // Keep the reserved search URL before the generic details route. Its exact middleware matches /sessions/:id.
  router.get('/sessions/search', async (c) => {
    const parsed = search.safeParse(c.req.query()); if (!parsed.success) return failure(c, 'INVALID_ARGUMENT');
    const v = parsed.data;
    return c.json(await options.port.searchSessions({ principal: c.get('relayStoragePrincipal')!, query: v.q, limit: v.limit,
      scope: v.scope ?? (c.get('relayActor').role === 'admin' ? 'all' : 'mine'),
      ...(v.ownerUserId === undefined ? {} : { ownerUserId: v.ownerUserId }) }));
  });
  router.get('/sessions/:id/search-matches', async (c) => {
    const id = uuid.safeParse(c.req.param('id')), parsed = messageSearch.safeParse(c.req.query());
    if (!id.success || !parsed.success) return failure(c, 'INVALID_ARGUMENT');
    return c.json(await options.port.searchSessionMessages({ principal: c.get('relayStoragePrincipal')!, sessionId: id.data,
      query: parsed.data.q, limit: parsed.data.limit, includeProcess: parsed.data.includeProcess === '1', includeOperations: parsed.data.includeOperations === '1' }));
  });
  router.get('/sessions/:id', async (c) => {
    const id = uuid.safeParse(c.req.param('id')); if (!id.success) return failure(c, 'INVALID_ARGUMENT');
    const session = await options.port.readSessionDetails({ principal: c.get('relayStoragePrincipal')!, sessionId: id.data });
    return session ? c.json(session) : failure(c, 'NOT_FOUND');
  });
  router.get('/sessions/:id/message-page', async (c) => {
    const id = uuid.safeParse(c.req.param('id')), parsed = messagePage.safeParse(c.req.query());
    if (!id.success || !parsed.success) return failure(c, 'INVALID_ARGUMENT');
    const v = parsed.data;
    return c.json(await options.port.readMessagePage({ principal: c.get('relayStoragePrincipal')!, sessionId: id.data, limit: v.limit,
      before: v.beforeId !== undefined && v.beforeCreatedAt !== undefined ? { id: v.beforeId, createdAt: v.beforeCreatedAt } : null,
      knownRevision: v.knownRevision ?? null }));
  });
  router.get('/sessions/:id/messages/:messageId/details', async (c) => {
    const id = uuid.safeParse(c.req.param('id')), messageId = z.string().min(1).max(256).safeParse(c.req.param('messageId'));
    if (!id.success || !messageId.success) return failure(c, 'INVALID_ARGUMENT');
    return c.json(await options.port.readMessageDetails({ principal: c.get('relayStoragePrincipal')!, sessionId: id.data, messageId: messageId.data }));
  });
  router.get('/sessions/:id/messages/:messageId/subagent-report', async (c) => {
    const id = uuid.safeParse(c.req.param('id'));
    const messageId = z.string().min(1).max(256).safeParse(c.req.param('messageId'));
    const query = z.object({ itemId: z.string().min(1).max(256) }).strict().safeParse(c.req.query());
    if (!id.success || !messageId.success || !query.success) return failure(c, 'INVALID_ARGUMENT');
    const principal = c.get('relayStoragePrincipal')!;
    const session = await options.port.readSessionDetails({ principal, sessionId: id.data });
    if (!session || session.engine !== 'codex') return failure(c, 'NOT_FOUND');
    const reference = { principal, sessionId: id.data, messageId: messageId.data };
    const details = await options.port.readMessageDetails(reference);
    const item = details.items?.find(item => item.id === query.data.itemId && item.type === 'subAgentActivity');
    const childId = item?.details.agentThreadId;
    if (item?.details.kind !== 'completed' || item.status !== 'completed' || typeof childId !== 'string'
      || !childId || childId.length > 256 || !item.id.startsWith('subagent-completed-')) return failure(c, 'NOT_FOUND');
    let content: string | null;
    try { content = await (options.loadSubAgentReport ?? readCodexSubAgentReport)(childId, item.id); }
    catch { return c.json(presentApiError('子任务回报暂不可用，请稍后重试'), 503); }
    // Recheck access after the external read; permissions/deletion may have changed while awaiting it.
    await options.port.readMessageDetails(reference);
    if (!content) return c.json(presentApiError('此完成记录没有可确认的结果回报'), 404);
    return c.json(SubAgentReportDtoSchema.parse({ content }));
  });
  router.get('/sessions/:id/messages', async (c) => {
    const id = uuid.safeParse(c.req.param('id')), parsed = messageList.safeParse(c.req.query());
    if (!id.success || !parsed.success) return failure(c, 'INVALID_ARGUMENT');
    return c.json(await options.port.readMessagesOffset({ principal: c.get('relayStoragePrincipal')!, sessionId: id.data,
      limit: parsed.data.limit, offset: parsed.data.offset, includeDetails: parsed.data.details !== '0' }));
  });
  return router;
}
