import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { presentApiError, SessionUpdateResponseDtoSchema } from '../contracts/index.js';
import { isAllowedOrigin } from '../security.js';
import { StorageContractError } from '../storage/command-boundary.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import type { StoredUnarchiveService } from '../services/stored-unarchive.js';
export function createStoredUnarchiveRouter(options: { port: CoreStoragePort; service: StoredUnarchiveService;
  assertNotDeleting: (sessionId: string) => void }) {
  options = Object.freeze({ ...options });
  const router = new Hono<RelayEnv>(), uuid = z.string().uuid();
  router.use('/sessions/:id/unarchive', createRequireStoredUserSession(options.port));
  router.onError((error, c) => {
    const code = error instanceof StorageContractError ? error.code : 'STORAGE_UNAVAILABLE';
    const status = code === 'INVALID_ARGUMENT' ? 400 : code === 'FORBIDDEN' || code === 'NOT_FOUND' ? 404 : code === 'CONFLICT' || code === 'OPERATION_EXPIRED' ? 409 : 503;
    return c.json(presentApiError(status === 404 ? '会话不存在或没有操作权限' : status === 409 ? '会话状态已变化，请刷新核对' : '取消归档暂不可用', { code }), status);
  });
  router.post('/sessions/:id/unarchive', async (c) => {
    if (!isAllowedOrigin(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许'), 403);
    const id = uuid.safeParse(c.req.param('id')), key = uuid.safeParse(c.req.header('x-relay-operation-id') ?? randomUUID());
    if (!id.success || !key.success) return c.json(presentApiError('无效的会话或操作标识'), 400);
    c.header('x-relay-operation-id', key.data); options.assertNotDeleting(id.data);
    const result = await options.service.run(c.get('relayStoragePrincipal')!, id.data, key.data);
    if (result.state === 'unknown') return c.json(presentApiError('取消归档结果暂时无法确认，请刷新核对', { code: 'EXTERNAL_RESULT_UNKNOWN' }), 503);
    if (!result.session) return c.json(presentApiError('取消归档已保存，当前状态暂不可用', { code: 'RESOURCE_STATE_UNAVAILABLE' }), 503);
    return c.json(SessionUpdateResponseDtoSchema.parse({ ok: true, session: result.session }));
  });
  return router;
}
