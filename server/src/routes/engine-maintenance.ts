import { Hono } from 'hono';
import { z } from 'zod';
import { EngineIdSchema, EngineMaintenanceActionSchema, EngineMaintenanceOperationDtoSchema, EngineMaintenanceResponseDtoSchema, EngineMaintenanceStatusDtoSchema, MaintenanceOutputSnapshotDtoSchema, presentApiError } from '../contracts/index.js';
import { isAllowedOrigin } from '../security.js';
import { EngineMaintenanceServiceError, type EngineMaintenanceService, type EngineMaintenanceUser } from '../system/engine-maintenance.js';

const reserveSchema = z.object({ engineId: EngineIdSchema, action: EngineMaintenanceActionSchema, confirmInterrupt: z.boolean().optional() }).strict();
const confirmSchema = z.object({ operationId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/), engineId: EngineIdSchema, action: EngineMaintenanceActionSchema }).strict();

export function createEngineMaintenanceRouter(dependencies: {
  service: EngineMaintenanceService;
  authenticate: (cookie?: string | null) => EngineMaintenanceUser | null | Promise<EngineMaintenanceUser|null>;
  isOriginAllowed?: (origin?: string | null) => boolean;
}) {
  const router = new Hono();
  const authenticate = dependencies.authenticate;
  const originAllowed = dependencies.isOriginAllowed ?? isAllowedOrigin;
  const user = (c: any) => authenticate(c.req.header('cookie'));
  const reauthorize=(c:any,current:EngineMaintenanceUser,admin:boolean)=>async()=>{
    const fresh=await user(c);if(!fresh||fresh.id!==current.id||(admin&&fresh.role!=='admin'))throw new EngineMaintenanceServiceError('forbidden');
  };

  router.get('/engine-maintenance', async (c) => {
    if (!await user(c)) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    return c.json(EngineMaintenanceResponseDtoSchema.parse(await dependencies.service.getSnapshot()));
  });
  router.post('/engine-maintenance/:engineId/check', async (c) => {
    if (!await user(c)) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    const engineId = EngineIdSchema.safeParse(c.req.param('engineId'));
    if (!engineId.success) return c.json(presentApiError('未知引擎', { code: 'ENGINE_MAINTENANCE_NOT_FOUND' }), 404);
    return c.json(EngineMaintenanceStatusDtoSchema.parse(await dependencies.service.checkLatest(engineId.data)));
  });
  router.get('/engine-maintenance/operations/:operationId', async (c) => {
    if (!await user(c)) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    const operationId = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).safeParse(c.req.param('operationId'));
    if (!operationId.success) return c.json(presentApiError('维护操作编号无效', { code: 'ENGINE_MAINTENANCE_INVALID' }), 400);
    const operation = dependencies.service.getOperation(operationId.data);
    if (!operation) return c.json(presentApiError('维护操作不存在或已过期', { code: 'ENGINE_MAINTENANCE_OPERATION_NOT_FOUND' }), 404);
    const output = await dependencies.service.getOperationOutput(operationId.data);
    return c.json(EngineMaintenanceOperationDtoSchema.parse({
      ...operation,
      output: output === null ? null : MaintenanceOutputSnapshotDtoSchema.parse(output),
    }));
  });
  router.post('/engine-maintenance/reserve', async (c) => {
    const current = await user(c);
    if (!current) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    if (!originAllowed(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'ENGINE_MAINTENANCE_ORIGIN_FORBIDDEN' }), 403);
    const parsed = reserveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(presentApiError('引擎维护请求格式无效', { code: 'ENGINE_MAINTENANCE_INVALID' }), 400);
    try { return c.json(await dependencies.service.reserve({ user: current, ...parsed.data,reauthorize:reauthorize(c,current,parsed.data.action!=='recheck') }), 202); }
    catch (error) { return respondError(c, error); }
  });
  router.post('/engine-maintenance/confirm', async (c) => {
    const current = await user(c);
    if (!current) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    if (!originAllowed(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'ENGINE_MAINTENANCE_ORIGIN_FORBIDDEN' }), 403);
    const parsed = confirmSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(presentApiError('引擎维护确认格式无效', { code: 'ENGINE_MAINTENANCE_INVALID' }), 400);
    if (parsed.data.action !== 'recheck' && current.role !== 'admin') return c.json(presentApiError('仅管理员可以维护引擎', { code: 'ENGINE_MAINTENANCE_FORBIDDEN' }), 403);
    try{
    if (!await dependencies.service.confirm(parsed.data.operationId, parsed.data.engineId, parsed.data.action,reauthorize(c,current,parsed.data.action!=='recheck'))) {
      return c.json(presentApiError('引擎维护确认已失效', { code: 'ENGINE_MAINTENANCE_CONFIRMATION_EXPIRED' }), 409);
    }
    return c.json({ status: 'committed' }, 202);
    }catch(error){return respondError(c,error);}
  });
  router.post('/engine-maintenance/operations/:operationId/abort', async (c) => {
    const current = await user(c);
    if (!current) return c.json(presentApiError('请先登录', { code: 'AUTH_REQUIRED' }), 401);
    if (!originAllowed(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'ENGINE_MAINTENANCE_ORIGIN_FORBIDDEN' }), 403);
    if (current.role !== 'admin') return c.json(presentApiError('仅管理员可以维护引擎', { code: 'ENGINE_MAINTENANCE_FORBIDDEN' }), 403);
    const operationId = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).safeParse(c.req.param('operationId'));
    if (!operationId.success) return c.json(presentApiError('维护操作编号无效', { code: 'ENGINE_MAINTENANCE_INVALID' }), 400);
    const operation = dependencies.service.getOperation(operationId.data);
    if (!operation) return c.json(presentApiError('维护操作不存在或已过期', { code: 'ENGINE_MAINTENANCE_OPERATION_NOT_FOUND' }), 404);
    if (operation.status !== 'processing') return c.json(presentApiError('维护操作已结束，无需中止', { code: 'ENGINE_MAINTENANCE_OPERATION_FINISHED' }), 409);
    if (!await dependencies.service.abortOperation(operationId.data, operation.engineId, operation.action)) {
      return c.json(presentApiError('中止请求未送达启动器，请稍后重试', { code: 'ENGINE_MAINTENANCE_ABORT_UNREACHABLE' }), 502);
    }
    return c.json({ status: 'aborting' }, 202);
  });
  return router;
}

function respondError(c: any, error: unknown) {
  if (!(error instanceof EngineMaintenanceServiceError)) throw error;
  if (error.code === 'forbidden') return c.json(presentApiError('仅管理员可以维护引擎', { code: 'ENGINE_MAINTENANCE_FORBIDDEN' }), 403);
  if (error.code === 'unmanaged') return c.json(presentApiError('当前启动器不支持引擎维护，请在终端运行 npm run restart', { code: 'ENGINE_MAINTENANCE_UNMANAGED' }), 422);
  if (error.code === 'action_blocked') return c.json(presentApiError('当前引擎状态不允许执行该操作', { code: 'ENGINE_MAINTENANCE_BLOCKED' }), 409);
  if (error.code === 'operation_in_progress') return c.json(presentApiError('已有维护操作正在进行', { code: 'ENGINE_MAINTENANCE_IN_PROGRESS' }), 409);
  if (error.code === 'rate_limited') return c.json(presentApiError('引擎维护操作冷却中，请稍后重试', { code: 'ENGINE_MAINTENANCE_RATE_LIMITED', details: error.details }), 429);
  if (error.code === 'setup_required') return c.json(presentApiError('环境需要修复，请在终端运行 npm run setup', { code: 'ENGINE_MAINTENANCE_SETUP_REQUIRED' }), 409);
  if (error.code === 'setup_blocked') return c.json(presentApiError('存在未解决的 Git 冲突，无法维护引擎', { code: 'ENGINE_MAINTENANCE_SETUP_BLOCKED' }), 409);
  return c.json(presentApiError('启动器引擎控制通道不可用，请在终端运行 npm run restart', { code: 'ENGINE_MAINTENANCE_IPC_UNAVAILABLE' }), 503);
}
