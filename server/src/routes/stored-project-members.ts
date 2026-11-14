import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { UserListResponseDtoSchema, presentApiError } from '../contracts/index.js';
import { isAllowedOrigin } from '../security.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import { StorageContractError } from '../storage/command-boundary.js';
import type { CoreStoragePort, StorageCommandEnvelope, StorageRejectionCode } from '../storage/contracts.js';

/** Candidate module; bootstrap must select the complete Worker-backed graph before mounting it. */
export function createStoredProjectMembersRouter(options: {
  port: CoreStoragePort; storeId: string; generation: number;
  // Recheck current subscriptions and publish fresh projections. Never interpret this as a grant/revoke event.
  recheckProjectAccess: (projectId: string, userId: string) => void | Promise<void>;
}) {
  options = Object.freeze({ ...options });
  const router = new Hono<RelayEnv>();
  const guard = createRequireStoredUserSession(options.port);
  const path = '/projects/:id/members';
  for (const route of [path, `${path}/candidates`, `${path}/:userId`]) router.use(route, guard);
  const uuid = z.string().uuid();
  const bodySchema = z.object({ role: z.enum(['viewer', 'collaborator', 'manager']),
    can_view_sessions: z.union([z.literal(0), z.literal(1)]).optional() }).strict();
  function failure(c: Context<RelayEnv>, code: StorageRejectionCode) {
    if (code === 'FORBIDDEN') return c.json(presentApiError('没有权限管理项目授权', { code: 'PROJECT_MEMBER_FORBIDDEN' }), 403);
    if (code === 'NOT_FOUND') return c.json(presentApiError('项目或账号不存在'), 404);
    if (code === 'INVALID_ARGUMENT') return c.json(presentApiError('无效的项目成员参数'), 400);
    if (code === 'CONFLICT' || code === 'OPERATION_EXPIRED') return c.json(presentApiError('操作冲突或已过期，请刷新状态', { code }), 409);
    return c.json(presentApiError('存储暂不可用，请稍后刷新状态', { code: code === 'PAYLOAD_TOO_LARGE' ? code : 'STORAGE_UNAVAILABLE' }), 503);
  }
  router.onError((error, c) => failure(c, error instanceof StorageContractError ? error.code : 'STORAGE_UNAVAILABLE'));
  for (const candidates of [false, true]) router.get(candidates ? `${path}/candidates` : path, async (c) => {
    const projectId = uuid.safeParse(c.req.param('id'));
    if (!projectId.success) return failure(c, 'INVALID_ARGUMENT');
    const principal = c.get('relayStoragePrincipal')!;
    return candidates
      ? c.json(UserListResponseDtoSchema.parse({ users: await options.port.listProjectMemberCandidates({ principal, projectId: projectId.data }) }))
      : c.json(await options.port.readProjectMembers({ principal, projectId: projectId.data }));
  });
  for (const method of ['PUT', 'DELETE'] as const) router.on(method, `${path}/:userId`, async (c) => {
    if (!isAllowedOrigin(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'PROJECT_MEMBER_ORIGIN_FORBIDDEN' }), 403);
    const projectId = uuid.safeParse(c.req.param('id')), userId = uuid.safeParse(c.req.param('userId'));
    const key = uuid.safeParse(c.req.header('x-relay-operation-id') ?? randomUUID());
    if (!projectId.success || !userId.success || !key.success) return failure(c, 'INVALID_ARGUMENT');
    c.header('x-relay-operation-id', key.data);
    let command: Extract<StorageCommandEnvelope['command'], { name: 'project.setMember' | 'project.removeMember' }>;
    if (method === 'DELETE') command = { name: 'project.removeMember', input: { projectId: projectId.data, userId: userId.data } };
    else {
      const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return failure(c, 'INVALID_ARGUMENT');
      command = { name: 'project.setMember', input: { projectId: projectId.data, userId: userId.data, role: parsed.data.role,
        ...(parsed.data.can_view_sessions === undefined ? {} : { canViewSessions: parsed.data.can_view_sessions === 1 }) } };
    }
    const result = await executeStoredCommand(options.port, { protocolVersion: 1, storeId: options.storeId,
      workerGeneration: options.generation, requestId: randomUUID(), operationId: `projectMember:${key.data}`,
      principal: c.get('relayStoragePrincipal')!, command });
    if (result.state === 'rejected') return failure(c, result.code);
    // Also reconcile unknown outcomes: permission might have committed before the reply was lost.
    // No receipt payload enters broadcasts, including when this is an old operation replay.
    try { await options.recheckProjectAccess(projectId.data, userId.data); }
    catch { console.warn('[ProjectMembers] 连接权限重核暂不可用'); }
    if (result.state === 'unknown') return c.json(presentApiError('成员授权结果暂时无法确认，请刷新状态核对', { code: 'STORAGE_RESULT_UNKNOWN' }), 503);
    return c.json({ ok: true });
  });
  return router;
}
