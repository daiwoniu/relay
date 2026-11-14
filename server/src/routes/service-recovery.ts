import { Hono } from 'hono';
import { z } from 'zod';
import { MaintenanceOutputSnapshotDtoSchema, presentApiError } from '../contracts/index.js';
import { isAllowedOrigin } from '../security.js';
import {
  ServiceRecoveryError,
  type RecoveryUser,
  type ServiceRecovery,
} from '../system/service-recovery.js';

const recoveryRequestSchema = z.object({
  action: z.enum(['auto', 'restart_backend', 'restart_frontend', 'restart_relay', 'repair_environment']),
  clientProtocolVersion: z.number().int().nonnegative().max(1_000_000),
  confirmActiveTasks: z.boolean().optional().default(false),
}).strict();

const recoveryCommitSchema = z.object({
  operationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  target: z.enum(['backend', 'frontend', 'relay', 'setup']),
}).strict();

interface ServiceRecoveryRouterDependencies {
  service: ServiceRecovery;
  authenticate: (cookieHeader?: string | null) => RecoveryUser | null | Promise<RecoveryUser|null>;
  isOriginAllowed?: (origin?: string | null) => boolean;
}

function respondRecoveryError(c: Parameters<Parameters<Hono['onError']>[0]>[1], error: ServiceRecoveryError): Response {
  switch (error.code) {
    case 'forbidden':
      return c.json(presentApiError('仅管理员可以恢复服务', { code: 'RECOVERY_FORBIDDEN' }), 403);
    case 'unmanaged':
      return c.json(presentApiError('当前服务不是由 Relay 启动器托管', { code: 'RECOVERY_UNMANAGED' }), 422);
    case 'launcher_incompatible':
      return c.json(presentApiError('Relay 启动器版本较旧，需要完整重启 Relay', { code: 'RECOVERY_LAUNCHER_INCOMPATIBLE' }), 409);
    case 'active_tasks':
      return c.json(presentApiError('存在运行中或等待处理的任务', { code: 'RECOVERY_ACTIVE_TASKS' }), 409);
    case 'operation_in_progress':
      return c.json(presentApiError('已有服务恢复操作正在进行', { code: 'RECOVERY_IN_PROGRESS' }), 409);
    case 'rate_limited': {
      const retryAfterSeconds = Math.max(1, Math.ceil((error.details.retryAfterMs || 0) / 1_000));
      c.header('Retry-After', String(retryAfterSeconds));
      return c.json(presentApiError(`服务重启冷却中，请等待 ${retryAfterSeconds} 秒后重新检测并重试`, { code: 'RECOVERY_RATE_LIMITED' }), 429);
    }
    case 'setup_required':
      return c.json(presentApiError('依赖状态需要先执行初始化', { code: 'RECOVERY_SETUP_REQUIRED' }), 409);
    case 'setup_blocked':
      return c.json(presentApiError('存在未解决的 Git 冲突，无法执行一键初始化', { code: 'RECOVERY_SETUP_BLOCKED' }), 409);
    case 'environment_ready':
      return c.json(presentApiError('Relay 环境已经初始化，无需修复', { code: 'RECOVERY_ENVIRONMENT_READY' }), 409);
    case 'restart_failed':
      return c.json(presentApiError(error.details.message || '完整重启准备失败，现有服务仍在运行', { code: 'RECOVERY_RESTART_FAILED' }), 409);
    case 'ipc_unavailable':
      return c.json(presentApiError('启动器控制通道不可用', { code: 'RECOVERY_IPC_UNAVAILABLE' }), 503);
  }
}

export function createServiceRecoveryRouter(dependencies: ServiceRecoveryRouterDependencies) {
  const router = new Hono();
  const authenticate = dependencies.authenticate;
  const isOriginAllowed = dependencies.isOriginAllowed ?? isAllowedOrigin;

  router.get('/recovery-capabilities', async (c) => {
    const user = await authenticate(c.req.header('cookie'));
    if (!user) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    return c.json(await dependencies.service.getCapabilities(user));
  });

  router.get('/recovery-operations/:operationId/output', async (c) => {
    if (!await authenticate(c.req.header('cookie'))) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    const operationId = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).safeParse(c.req.param('operationId'));
    if (!operationId.success) return c.json(presentApiError('服务维护操作编号无效', { code: 'RECOVERY_INVALID_OPERATION' }), 400);
    const output = await dependencies.service.getOperationOutput(operationId.data);
    return c.json(output === null ? null : MaintenanceOutputSnapshotDtoSchema.parse(output));
  });

  router.post('/recover', async (c) => {
    const user = await authenticate(c.req.header('cookie'));
    if (!user) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    if (user.role !== 'admin') {
      return c.json(presentApiError('仅管理员可以恢复服务', { code: 'RECOVERY_FORBIDDEN' }), 403);
    }

    const origin = c.req.header('origin')?.trim();
    if (!origin || !isOriginAllowed(origin)) {
      return c.json(presentApiError('请求来源不受允许', { code: 'RECOVERY_ORIGIN_FORBIDDEN' }), 403);
    }

    const parsed = recoveryRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(presentApiError('服务恢复请求格式无效', { code: 'RECOVERY_INVALID_REQUEST' }), 400);
    }

    try {
      const reauthorize=async()=>{const current=await authenticate(c.req.header('cookie'));if(!current||current.id!==user.id||current.role!=='admin')throw new ServiceRecoveryError('forbidden');};
      const result = await dependencies.service.requestRecovery({ user, ...parsed.data,reauthorize });
      return result.status === 'accepted' ? c.json(result, 202) : c.json(result);
    } catch (error) {
      if (error instanceof ServiceRecoveryError) return respondRecoveryError(c, error);
      throw error;
    }
  });

  router.post('/recover/confirm', async (c) => {
    const user = await authenticate(c.req.header('cookie'));
    if (!user) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    if (user.role !== 'admin') {
      return c.json(presentApiError('仅管理员可以恢复服务', { code: 'RECOVERY_FORBIDDEN' }), 403);
    }

    const origin = c.req.header('origin')?.trim();
    if (!origin || !isOriginAllowed(origin)) {
      return c.json(presentApiError('请求来源不受允许', { code: 'RECOVERY_ORIGIN_FORBIDDEN' }), 403);
    }

    const parsed = recoveryCommitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(presentApiError('服务恢复确认格式无效', { code: 'RECOVERY_INVALID_CONFIRMATION' }), 400);
    }
    try {
      const reauthorize=async()=>{const current=await authenticate(c.req.header('cookie'));if(!current||current.id!==user.id||current.role!=='admin')throw new ServiceRecoveryError('forbidden');};
      if (!await dependencies.service.confirmOperation(parsed.data.operationId, parsed.data.target,reauthorize)) {
        return c.json(presentApiError('服务恢复确认已失效', { code: 'RECOVERY_CONFIRMATION_EXPIRED' }), 409);
      }
    } catch (error) {
      if (error instanceof ServiceRecoveryError) return respondRecoveryError(c, error);
      throw error;
    }
    return c.json({ status: 'committed' }, 202);
  });

  return router;
}
