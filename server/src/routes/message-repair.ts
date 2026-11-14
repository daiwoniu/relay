import { Hono } from 'hono';
import { z } from 'zod';
import { getRequestActor, type Actor, type RelayEnv } from '../auth/authorization.js';
import { isAllowedOrigin } from '../security.js';
import { presentApiError } from '../contracts/index.js';
import { ServiceError } from '../services/errors.js';
import { createOnlineTerminalRepair } from '../services/online-terminal-repair.js';

export function createMessageRepairRouter(options: {
  service: ReturnType<typeof createOnlineTerminalRepair>;
  actor?: (c: Parameters<typeof getRequestActor>[0]) => Actor | undefined;
  originAllowed?: (origin: string) => boolean;
}) {
  const router = new Hono<RelayEnv>();
  router.post('/message-repair/:action', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const actor = (options.actor ?? getRequestActor)(c);
    if (!actor) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    if (actor.role !== 'admin') return c.json(presentApiError('仅管理员可以恢复消息', { code: 'MESSAGE_REPAIR_FORBIDDEN' }), 403);
    const origin = c.req.header('origin');
    if (!origin || !(options.originAllowed ?? isAllowedOrigin)(origin)) return c.json(presentApiError('请求来源不受允许', { code: 'MESSAGE_REPAIR_ORIGIN_FORBIDDEN' }), 403);
    const action = c.req.param('action');
    const body = await c.req.json().catch(() => null);
    try {
      if (action === 'preview') {
        const parsed = z.object({ cursor: z.string().min(1).max(200).optional() }).strict().safeParse(body);
        if (!parsed.success) return c.json(presentApiError('检测请求格式无效'), 400);
        return c.json(await options.service.preview(actor.userId, parsed.data.cursor));
      }
      if (action === 'apply') {
        const parsed = z.object({ planId: z.string().uuid() }).strict().safeParse(body);
        if (!parsed.success) return c.json(presentApiError('恢复请求格式无效'), 400);
        return c.json(options.service.apply(actor.userId, parsed.data.planId));
      }
      return c.json(presentApiError('操作不存在'), 404);
    } catch (error) {
      if (error instanceof ServiceError) return c.json(presentApiError(error.message, { code: error.code }), error.status);
      return c.json(presentApiError('消息恢复未完成，请重新检测', { code: 'MESSAGE_REPAIR_FAILED' }), 500);
    }
  });
  return router;
}
