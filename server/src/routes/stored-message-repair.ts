import { Hono } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { isAllowedOrigin } from '../security.js';
import { presentApiError } from '../contracts/index.js';
import { StorageContractError } from '../storage/command-boundary.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import type { StoredMessageRepair } from '../services/stored-message-repair.js';
export function createStoredMessageRepairRouter(options: { port: CoreStoragePort; service: StoredMessageRepair }) {
  options = Object.freeze({ ...options }); const router = new Hono<RelayEnv>();
  router.use('/message-repair/:action', createRequireStoredUserSession(options.port));
  router.onError((error, c) => {
    const code = error instanceof StorageContractError ? error.code : 'STORAGE_UNAVAILABLE';
    const status = code === 'FORBIDDEN' ? 403 : code === 'CONFLICT' || code === 'OPERATION_EXPIRED' ? 409 : code === 'INVALID_ARGUMENT' ? 400 : 503;
    return c.json(presentApiError(status === 409 ? '检测结果或运行状态已变化，请重新检测' : '消息恢复暂不可用，未确认的结果请刷新核对', { code }), status);
  });
  router.post('/message-repair/:action', async (c) => {
    c.header('Cache-Control','private, no-store');
    if (c.get('relayActor').role !== 'admin') return c.json(presentApiError('仅管理员可以恢复消息', { code: 'MESSAGE_REPAIR_FORBIDDEN' }), 403);
    const origin = c.req.header('origin'); if (!origin || !isAllowedOrigin(origin)) return c.json(presentApiError('请求来源不受允许', { code: 'MESSAGE_REPAIR_ORIGIN_FORBIDDEN' }), 403);
    const body = await c.req.json().catch(() => null), principal = c.get('relayStoragePrincipal')!;
    if (c.req.param('action') === 'preview') {
      const parsed = z.object({ cursor: z.string().min(1).max(200).optional() }).strict().safeParse(body);
      return parsed.success ? c.json(await options.service.preview(principal, parsed.data.cursor ?? null)) : c.json(presentApiError('检测请求格式无效'), 400);
    }
    if (c.req.param('action') === 'apply') {
      const parsed = z.object({ planId: z.string().uuid() }).strict().safeParse(body); if (!parsed.success) return c.json(presentApiError('恢复请求格式无效'), 400);
      const result = await options.service.apply(principal, parsed.data.planId);
      return result.state === 'committed' ? c.json({ restoredCount: result.restoredCount })
        : c.json(presentApiError('恢复结果暂时无法确认，请刷新核对', { code: 'MESSAGE_REPAIR_RESULT_UNKNOWN' }), 503);
    }
    return c.json(presentApiError('操作不存在'), 404);
  });
  return router;
}
