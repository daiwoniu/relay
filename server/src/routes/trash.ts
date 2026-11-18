import { Hono } from 'hono';
import { z } from 'zod';
import { presentApiError, TrashProjectDeleteRequestSchema, TrashSessionDeleteRequestSchema } from '../contracts/index.js';
import { createTrashService } from '../services/trash.js';
import { respondServiceError } from './service-error.js';
import { broadcastProjectDelete, broadcastProjectUpdate, broadcastSessionDelete, broadcastSessionUpdate, broadcastSidebarOrderUpdate } from '../ws/frontend.js';
import { createSidebarOrderService } from '../services/sidebar-order.js';
import { authenticateCookieHeader } from '../auth/middleware.js';
import { isAllowedOrigin } from '../security.js';
import { getRequestActor, type Actor, type RelayEnv } from '../auth/authorization.js';

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict();
const listSchema = paginationSchema.extend({ q: z.string().trim().max(100).optional(), projectId: z.string().uuid().optional(), creatorId: z.string().trim().min(1).max(128).optional() });
const idSchema = z.string().uuid();

type TrashService = ReturnType<typeof createTrashService>;
type TrashUser = { id: string; role: 'admin' | 'member' };

export function createTrashRouter({
  service = createTrashService(),
  authenticate = authenticateCookieHeader,
  isOriginAllowed = isAllowedOrigin,
}: {
  service?: TrashService;
  authenticate?: (cookie?: string | null) => TrashUser | null;
  isOriginAllowed?: (origin?: string | null) => boolean;
} = {}) {
  const router = new Hono<RelayEnv>();
  const actor = (c: Parameters<typeof getRequestActor>[0], authenticated?: TrashUser): Actor => authenticated
    ? { userId: authenticated.id, role: authenticated.role }
    : getRequestActor(c);
  router.get('/projects', (c) => {
    const parsed = listSchema.omit({ projectId: true }).safeParse(c.req.query());
    return parsed.success
      ? c.json(service.listProjectsForActor(actor(c), parsed.data.limit, parsed.data.offset, { query: parsed.data.q, creatorId: parsed.data.creatorId }))
      : c.json(presentApiError('无效的回收站分页参数'), 400);
  });
  router.get('/sessions', (c) => {
    const parsed = listSchema.safeParse(c.req.query());
    return parsed.success
      ? c.json(service.listSessionsForActor(actor(c), parsed.data.limit, parsed.data.offset, { query: parsed.data.q, projectId: parsed.data.projectId, creatorId: parsed.data.creatorId }))
      : c.json(presentApiError('无效的回收站分页参数'), 400);
  });
  router.get('/session-projects', (c) => c.json(service.listSessionProjectsForActor(actor(c))));
  router.get('/sessions/:id/matches', (c) => {
    const sessionId = idSchema.safeParse(c.req.param('id'));
    const query = z.object({ q: z.string().trim().min(1).max(100), offset: z.coerce.number().int().min(0).max(100_000).default(0) }).strict().safeParse(c.req.query());
    if (!sessionId.success || !query.success) return c.json(presentApiError('无效的回收站搜索参数'), 400);
    try {
      c.header('Cache-Control', 'private, no-store');
      return c.json(service.listSessionMatchesForActor(actor(c), sessionId.data, query.data.q, query.data.offset));
    } catch (error) { return respondServiceError(c, error); }
  });
  router.get('/sessions/:id/preview', (c) => {
    const sessionId = idSchema.safeParse(c.req.param('id'));
    if (!sessionId.success) return c.json(presentApiError('无效的会话标识'), 400);
    try {
      c.header('Cache-Control', 'private, no-store');
      return c.json(service.listSessionPreviewForActor(actor(c), sessionId.data));
    } catch (error) { return respondServiceError(c, error); }
  });
  router.get('/projects/:id/sessions', (c) => {
    const projectId = idSchema.safeParse(c.req.param('id'));
    const pagination = paginationSchema.safeParse(c.req.query());
    if (!projectId.success || !pagination.success) return c.json(presentApiError('无效的回收站查询参数'), 400);
    try {
      return c.json(service.listProjectSessionsForActor(actor(c), projectId.data, pagination.data.limit, pagination.data.offset));
    } catch (error) {
      return respondServiceError(c, error);
    }
  });
  router.get('/projects/:id/impact', (c) => {
    const projectId = idSchema.safeParse(c.req.param('id'));
    if (!projectId.success) return c.json(presentApiError('无效的项目标识'), 400);
    try { return c.json(service.getProjectImpactForActor(actor(c), projectId.data)); } catch (error) { return respondServiceError(c, error); }
  });
  router.get('/sessions/:id/impact', (c) => {
    const sessionId = idSchema.safeParse(c.req.param('id'));
    if (!sessionId.success) return c.json(presentApiError('无效的会话标识'), 400);
    try { return c.json(service.getSessionImpactForActor(actor(c), sessionId.data)); } catch (error) { return respondServiceError(c, error); }
  });
  router.post('/projects/:id/restore', async (c) => {
    const user = authenticate(c.req.header('cookie'));
    if (!user) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    if (!isOriginAllowed(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'TRASH_RESTORE_ORIGIN_FORBIDDEN' }), 403);
    const projectId = idSchema.safeParse(c.req.param('id'));
    if (!projectId.success) return c.json(presentApiError('无效的项目标识'), 400);
    try { return c.json(await service.restoreProjectForActor(actor(c, user), projectId.data)); } catch (error) { return respondServiceError(c, error); }
  });
  router.post('/sessions/:id/restore', async (c) => {
    const user = authenticate(c.req.header('cookie'));
    if (!user) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    if (!isOriginAllowed(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'TRASH_RESTORE_ORIGIN_FORBIDDEN' }), 403);
    const sessionId = idSchema.safeParse(c.req.param('id'));
    if (!sessionId.success) return c.json(presentApiError('无效的会话标识'), 400);
    try { return c.json(await service.restoreSessionForActor(actor(c, user), sessionId.data)); } catch (error) { return respondServiceError(c, error); }
  });
  router.delete('/projects/:id', async (c) => {
    const user = authenticate(c.req.header('cookie'));
    if (!user) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    if (user.role !== 'admin') return c.json(presentApiError('仅管理员可以彻底删除回收站项目', { code: 'TRASH_DELETE_FORBIDDEN' }), 403);
    if (!isOriginAllowed(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'TRASH_DELETE_ORIGIN_FORBIDDEN' }), 403);
    const projectId = idSchema.safeParse(c.req.param('id'));
    const body = TrashProjectDeleteRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!projectId.success || !body.success) return c.json(presentApiError('彻底删除项目请求无效'), 400);
    try { return c.json(service.prepareProjectPermanentDeleteForActor(actor(c, user), projectId.data, body.data)); } catch (error) { return respondServiceError(c, error); }
  });
  router.delete('/sessions/:id', async (c) => {
    const user = authenticate(c.req.header('cookie'));
    if (!user) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    if (user.role !== 'admin') return c.json(presentApiError('仅管理员可以彻底删除回收站会话', { code: 'TRASH_DELETE_FORBIDDEN' }), 403);
    if (!isOriginAllowed(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'TRASH_DELETE_ORIGIN_FORBIDDEN' }), 403);
    const sessionId = idSchema.safeParse(c.req.param('id'));
    const body = TrashSessionDeleteRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!sessionId.success || !body.success) return c.json(presentApiError('彻底删除会话请求无效'), 400);
    try { return c.json(service.prepareSessionPermanentDeleteForActor(actor(c, user), sessionId.data, body.data)); } catch (error) { return respondServiceError(c, error); }
  });
  return router;
}

const sidebarOrderService = createSidebarOrderService({ broadcast: { updated: broadcastSidebarOrderUpdate } });
export default createTrashRouter({ service: createTrashService(undefined, {
  broadcast: {
    projectUpdated: broadcastProjectUpdate,
    sessionUpdated: broadcastSessionUpdate,
    projectDeleted: broadcastProjectDelete,
    sessionDeleted: broadcastSessionDelete,
  },
  sidebarChanged: () => { sidebarOrderService.refreshAll(); },
  diagnostic: (message) => { console.warn(`[Relay] ${message}`); },
}) });
