import { Hono } from 'hono';
import { z } from 'zod';
import { authenticateCookieHeader } from '../auth/middleware.js';
import { EngineConcurrencyDtoSchema, OkDtoSchema, presentApiError, type EngineConcurrencyDto } from '../contracts/index.js';
import { isAllowedOrigin } from '../security.js';
import {
  cancelQueuedTurnForUser, listEngineConcurrencySnapshots, updateEngineConcurrency,
} from '../ws/frontend.js';

type User = { id: string; role: 'admin' | 'member' };
const resourceKeySchema = z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,119}$/);
const updateSchema = z.object({ maxActiveTurns: z.number().int().min(1).max(32) }).strict();

export function createEngineConcurrencyRouter(dependencies: {
  authenticate?: (cookie?: string | null) => User | null;
  isOriginAllowed?: (origin?: string | null) => boolean;
  list?: (user: User) => EngineConcurrencyDto[];
  update?: (resourceKey: string, maxActiveTurns: number, userId: string) => EngineConcurrencyDto;
  cancel?: (sessionId: string, user: User) => boolean;
} = {}) {
  const router = new Hono();
  const authenticate = dependencies.authenticate ?? authenticateCookieHeader;
  const originAllowed = dependencies.isOriginAllowed ?? isAllowedOrigin;
  const list = dependencies.list ?? listEngineConcurrencySnapshots;
  const update = dependencies.update ?? updateEngineConcurrency;
  const cancel = dependencies.cancel ?? cancelQueuedTurnForUser;

  router.get('/engine-concurrency', (c) => {
    const user = authenticate(c.req.header('cookie'));
    if (!user) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    return c.json(z.array(EngineConcurrencyDtoSchema).parse(list(user)));
  });

  router.patch('/engine-concurrency/:resourceKey', async (c) => {
    const user = authenticate(c.req.header('cookie'));
    if (!user) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    if (user.role !== 'admin') return c.json(presentApiError('仅管理员可以调整引擎并发', { code: 'ENGINE_CONCURRENCY_FORBIDDEN' }), 403);
    if (!originAllowed(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'ENGINE_CONCURRENCY_ORIGIN_FORBIDDEN' }), 403);
    const resourceKey = resourceKeySchema.safeParse(c.req.param('resourceKey'));
    const body = updateSchema.safeParse(await c.req.json().catch(() => null));
    if (!resourceKey.success || !body.success) return c.json(presentApiError('引擎并发设置格式无效', { code: 'ENGINE_CONCURRENCY_INVALID' }), 400);
    try {
      return c.json(EngineConcurrencyDtoSchema.parse(update(resourceKey.data, body.data.maxActiveTurns, user.id)));
    } catch {
      return c.json(presentApiError('未知引擎并发资源', { code: 'ENGINE_CONCURRENCY_NOT_FOUND' }), 404);
    }
  });

  router.post('/sessions/:sessionId/queued-turn/cancel', (c) => {
    const user = authenticate(c.req.header('cookie'));
    if (!user) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    if (!originAllowed(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'TURN_QUEUE_ORIGIN_FORBIDDEN' }), 403);
    const sessionId = z.string().uuid().safeParse(c.req.param('sessionId'));
    if (!sessionId.success) return c.json(presentApiError('会话编号无效', { code: 'TURN_QUEUE_INVALID' }), 400);
    try {
      if (!cancel(sessionId.data, user)) return c.json(presentApiError('排队回合不存在', { code: 'TURN_QUEUE_NOT_FOUND' }), 404);
      return c.json(OkDtoSchema.parse({ ok: true }));
    } catch {
      return c.json(presentApiError('无权取消该排队回合', { code: 'TURN_QUEUE_FORBIDDEN' }), 403);
    }
  });
  return router;
}

export default createEngineConcurrencyRouter();
