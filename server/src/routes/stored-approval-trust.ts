import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { PutProjectApprovalTrustRequestSchema, PutSessionApprovalTrustRequestSchema, presentApiError, type ApprovalTrustUpdatedEvent } from '../contracts/index.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import type { CoreStoragePort, StorageCommandEnvelope, StorageRejectionCode } from '../storage/contracts.js';
import { presentApprovalTrustState } from '../contracts/index.js';

/** Opt-in native-store router. Application bootstrap selects it with the complete Worker-backed service graph. */
export function createStoredApprovalTrustRouter(options: { port: CoreStoragePort; storeId: string; generation: number;
  broadcast: (event: ApprovalTrustUpdatedEvent, userId: string) => void | Promise<void> }) {
  options = Object.freeze({ ...options });
  const router = new Hono<RelayEnv>();
  const requireUser = createRequireStoredUserSession(options.port);
  router.use('/projects/:id/approval-trust', requireUser);
  router.use('/sessions/:id/approval-trust', requireUser);
  const idSchema = z.string().uuid();
  function failure(c: Context<RelayEnv>, code: StorageRejectionCode, label: string) {
    if (code === 'FORBIDDEN' || code === 'NOT_FOUND') return c.json(presentApiError(`${label}不存在`), 404);
    if (code === 'INVALID_ARGUMENT') return c.json(presentApiError('授权信任参数无效'), 400);
    if (code === 'CONFLICT' || code === 'OPERATION_EXPIRED') return c.json(presentApiError('操作与已有记录冲突或已过期，请刷新状态', { code }), 409);
    return c.json(presentApiError('存储暂不可用，请稍后刷新状态', { code: 'STORAGE_UNAVAILABLE' }), 503);
  }
  for (const scope of ['project', 'session'] as const) {
    const label = scope === 'project' ? '项目' : '会话';
    const route = `/${scope === 'project' ? 'projects' : 'sessions'}/:id/approval-trust`;
    router.get(route, async (c) => {
      const id = idSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.json(presentApiError(`${label}标识无效`), 400);
      const principal = c.get('relayStoragePrincipal');
      if (!principal) return failure(c, 'STORAGE_UNAVAILABLE', label);
      try { return c.json(presentApprovalTrustState(await options.port.readApprovalTrust({ principal, scope, scopeId: id.data }))); }
      catch (error) { return failure(c, error instanceof StorageContractError ? error.code : 'STORAGE_UNAVAILABLE', label); }
    });
    for (const method of ['PUT', 'DELETE'] as const) router.on(method, route, async (c) => {
      const id = idSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.json(presentApiError(`${label}标识无效`), 400);
      const principal = c.get('relayStoragePrincipal');
      if (!principal) return failure(c, 'STORAGE_UNAVAILABLE', label);
      const supplied = c.req.header('x-relay-operation-id');
      const key = idSchema.safeParse(supplied ?? randomUUID());
      if (!key.success) return c.json(presentApiError('操作标识无效'), 400);
      c.header('x-relay-operation-id', key.data);
      let command: Extract<StorageCommandEnvelope['command'], { name: 'approvalTrust.set' | 'approvalTrust.clear' }>;
      if (method === 'DELETE') command = { name: 'approvalTrust.clear', input: { scope, scopeId: id.data } };
      else {
        const parsed = (scope === 'project' ? PutProjectApprovalTrustRequestSchema.transform((value) => ({ ...value, mode: 'trusted' as const })) : PutSessionApprovalTrustRequestSchema)
          .safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) return c.json(presentApiError('无效的授权信任参数'), 400);
        command = { name: 'approvalTrust.set', input: { scope, scopeId: id.data, duration: parsed.data.duration,
          mode: parsed.data.mode } };
      }
      const request: StorageCommandEnvelope = { protocolVersion: 1, storeId: options.storeId, workerGeneration: options.generation,
        requestId: randomUUID(), operationId: `approvalTrust:${key.data}`, principal, command };
      try {
        const result = await executeStoredCommand(options.port, request);
        if (result.state === 'rejected') return failure(c, result.code, label);
        if (result.state === 'unknown') return c.json(presentApiError('设置结果暂时无法确认，请刷新状态核对', { code: 'STORAGE_RESULT_UNKNOWN' }), 503);
        let state;
        try { state = presentApprovalTrustState(await options.port.readApprovalTrust({ principal, scope, scopeId: id.data })); }
        catch { return c.json(presentApiError('设置已保存，状态暂时无法刷新', { code: 'APPROVAL_TRUST_STATE_UNAVAILABLE' }), 503); }
        try {
          // Invalidate only: an old receipt must never be broadcast as a new grant or an old setting value.
          await options.broadcast({ type: 'approval_trust_updated', scope, scopeId: id.data }, principal.userId);
        } catch { console.warn('[ApprovalTrust] 设置已提交，多端状态通知失败'); }
        return c.json(state);
      } catch (error) { return failure(c, error instanceof StorageContractError ? error.code : 'STORAGE_UNAVAILABLE', label); }
    });
  }
  return router;
}
