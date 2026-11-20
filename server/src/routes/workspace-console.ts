import { Hono } from 'hono';
import { presentApiError, WorkspaceConsoleResponsibilityDtoSchema, WorkspaceConsoleDashboardDtoSchema, WorkspaceOperationRecordsDtoSchema, WorkspaceTaskSessionLinkResponseDtoSchema } from '../contracts/index.js';
import { z } from 'zod';
import { getRequestActor, type Actor, type RelayEnv } from '../auth/authorization.js';
import { respondServiceError } from './service-error.js';
import { WorkspaceConsoleService } from '../workspace-console/workspace-console-service.js';
import { OperationRecordsService } from '../workspace-console/operation-records.js';
import { withFeishuReadBatch } from '../integrations/feishu/read-batch.js';

export function createWorkspaceConsoleRouter(options: {
  service?: Pick<WorkspaceConsoleService, 'getResponsibility' | 'getDashboard' | 'linkSession' | 'unlinkSession'>;
  operations?: Pick<OperationRecordsService, 'get'>;
  getActor?: (c: Parameters<typeof getRequestActor>[0]) => Actor;
} = {}) {
  const router = new Hono<RelayEnv>();
  const service = options.service ?? new WorkspaceConsoleService();
  const operations = options.operations ?? new OperationRecordsService();
  const actor = options.getActor ?? getRequestActor;
  router.get('/dashboard', async (c) => {
    const currentActor = actor(c);
    if (currentActor.role !== 'admin') return c.json(presentApiError('仅管理员可以查看工作区控制台', { code: 'WORKSPACE_CONSOLE_FORBIDDEN' }), 403);
    try { c.header('Cache-Control', 'private, no-store'); return c.json(WorkspaceConsoleDashboardDtoSchema.parse(await service.getDashboard(currentActor, { force: c.req.query('refresh') === '1' }))); }
    catch (error) { return respondServiceError(c, error); }
  });
  router.get('/responsibility', async (c) => {
    const currentActor = actor(c);
    if (currentActor.role !== 'admin') return c.json(presentApiError('仅管理员可以查看工作区控制台', { code: 'WORKSPACE_CONSOLE_FORBIDDEN' }), 403);
    const force = c.req.query('refresh') === '1';
    const rawTrigger = c.req.query('trigger');
    const trigger = rawTrigger === 'open' || rawTrigger === 'auto' || rawTrigger === 'retry' || rawTrigger === 'manual' || rawTrigger === 'detail'
      ? rawTrigger : 'unknown';
    const startedAt = performance.now();
    try {
      c.header('Cache-Control', 'private, no-store');
      const report = WorkspaceConsoleResponsibilityDtoSchema.parse(await withFeishuReadBatch(()=>service.getResponsibility(currentActor, { force })));
      console.info(`[WorkspaceResponsibility] request=${JSON.stringify({ trigger, force, elapsedMs: Math.round(performance.now() - startedAt), servedFromCache: report.servedFromCache === true, stale: report.stale })}`);
      return c.json(report);
    } catch (error) {
      console.info(`[WorkspaceResponsibility] request=${JSON.stringify({ trigger, force, elapsedMs: Math.round(performance.now() - startedAt), outcome: 'error' })}`);
      return respondServiceError(c, error);
    }
  });
  router.get('/operations/:parentId', async (c) => {
    const currentActor = actor(c);
    if (currentActor.role !== 'admin') return c.json(presentApiError('仅管理员可以查看飞书操作记录', { code: 'WORKSPACE_CONSOLE_FORBIDDEN' }), 403);
    try {
      c.header('Cache-Control', 'private, no-store');
      return c.json(WorkspaceOperationRecordsDtoSchema.parse(await operations.get(currentActor, c.req.param('parentId'),
        c.req.query('anchor') ?? '', c.req.query('cursor') ?? null, c.req.query('refresh') === '1')));
    } catch (error) { return respondServiceError(c, error); }
  });
  router.post('/tasks/:taskId/sessions', async (c) => {
    const currentActor = actor(c);
    if (currentActor.role !== 'admin') return c.json(presentApiError('仅管理员可以操作任务关联', { code: 'WORKSPACE_CONSOLE_FORBIDDEN' }), 403);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json(presentApiError('请求体不是有效 JSON'), 400); }
    const parsed = z.object({ sessionId: z.string().min(1) }).strict().safeParse(body);
    if (!parsed.success) return c.json(presentApiError('请求体字段无效'), 400);
    try { c.header('Cache-Control', 'private, no-store'); return c.json(WorkspaceTaskSessionLinkResponseDtoSchema.parse(await service.linkSession(currentActor, c.req.param('taskId'), parsed.data.sessionId))); }
    catch (error) { return respondServiceError(c, error); }
  });
  router.delete('/tasks/:taskId/sessions/:sessionId', async (c) => {
    const currentActor = actor(c);
    if (currentActor.role !== 'admin') return c.json(presentApiError('仅管理员可以操作任务关联', { code: 'WORKSPACE_CONSOLE_FORBIDDEN' }), 403);
    try { c.header('Cache-Control', 'private, no-store'); return c.json(WorkspaceTaskSessionLinkResponseDtoSchema.parse(await service.unlinkSession(currentActor, c.req.param('taskId'), c.req.param('sessionId')))); }
    catch (error) { return respondServiceError(c, error); }
  });
  return router;
}

export default createWorkspaceConsoleRouter();
