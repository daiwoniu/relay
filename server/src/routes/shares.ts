import { Hono } from 'hono';
import { CreateShareRequestSchema, OkDtoSchema, presentApiError } from '../contracts/index.js';
import { authenticateCookieHeader } from '../auth/middleware.js';
import { shareService, type ShareService } from '../services/shares.js';
import { respondServiceError } from './service-error.js';
import type { Actor } from '../auth/authorization.js';

function parsePagination(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(0, parsed)) : fallback;
}

export function createSharesRouter({
  service = shareService,
  authenticate = authenticateCookieHeader,
}: {
  service?: ShareService;
  authenticate?: typeof authenticateCookieHeader;
} = {}) {
  const router = new Hono();

  router.post('/preview', async (c) => {
    const user = authenticate(c.req.header('cookie'));
    if (!user) return c.json(presentApiError('请先登录'), 401);
    const parsed = CreateShareRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(presentApiError('无效的分享参数'), 400);
    try {
      return c.json(service.previewForActor({ userId: user.id, role: user.role } satisfies Actor, parsed.data));
    } catch (error) {
      return respondServiceError(c, error);
    }
  });

  router.post('/', async (c) => {
    const user = authenticate(c.req.header('cookie'));
    if (!user) return c.json(presentApiError('请先登录'), 401);
    const parsed = CreateShareRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(presentApiError('无效的分享参数'), 400);
    try {
      return c.json(service.createForActor({ userId: user.id, role: user.role } satisfies Actor, parsed.data), 201);
    } catch (error) {
      return respondServiceError(c, error);
    }
  });

  router.get('/', (c) => {
    const user = authenticate(c.req.header('cookie'));
    if (!user) return c.json(presentApiError('请先登录'), 401);
    return c.json(service.listForActor(
      { userId: user.id, role: user.role } satisfies Actor,
      parsePagination(c.req.query('limit'), 50, 100),
      parsePagination(c.req.query('offset'), 0, 100_000),
    ));
  });

  router.post('/:id/revoke', (c) => {
    const user = authenticate(c.req.header('cookie'));
    if (!user) return c.json(presentApiError('请先登录'), 401);
    try {
      service.revokeForActor({ userId: user.id, role: user.role } satisfies Actor, c.req.param('id'));
      return c.json(OkDtoSchema.parse({ ok: true }));
    } catch (error) {
      return respondServiceError(c, error);
    }
  });

  router.delete('/:id', (c) => {
    const user = authenticate(c.req.header('cookie'));
    if (!user) return c.json(presentApiError('请先登录'), 401);
    try {
      service.deleteForActor({ userId: user.id, role: user.role } satisfies Actor, c.req.param('id'));
      return c.json(OkDtoSchema.parse({ ok: true }));
    } catch (error) {
      return respondServiceError(c, error);
    }
  });

  return router;
}

export default createSharesRouter();
