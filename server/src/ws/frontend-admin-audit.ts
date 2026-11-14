import type { Actor } from '../auth/authorization.js';
import { recordAdminAudit, type AdminAuditAction, type AdminAuditResult } from '../db/admin-audit.js';

export interface AdminAuditCompletion {
  finish(result: AdminAuditResult): void;
}

const noAudit: AdminAuditCompletion = { finish: () => undefined };

export function beginSessionAdminAudit(
  actor: Actor,
  session: { id: string; owner_user_id?: string | null } | undefined,
  action: AdminAuditAction,
  options: {
    record?: typeof recordAdminAudit;
    diagnostic?: (message: string, error: unknown) => void;
  } = {},
): AdminAuditCompletion {
  if (actor.role !== 'admin' || !session?.owner_user_id || session.owner_user_id === actor.userId) return noAudit;
  const input = {
    actorUserId: actor.userId, action, resourceType: 'session' as const,
    resourceId: session.id, ownerUserId: session.owner_user_id,
  };
  const record = options.record ?? recordAdminAudit;
  const diagnostic = options.diagnostic ?? ((message: string, error: unknown) => console.error(`[Relay] ${message}:`, error));
  try { record({ ...input, result: 'started' }); }
  catch (error) {
    diagnostic('WebSocket 管理员代操作开始审计写入失败', error);
    throw error;
  }
  return {
    finish(result) {
      try { record({ ...input, result }); }
      catch (error) { diagnostic('WebSocket 管理员代操作终态审计写入失败', error); }
    },
  };
}

export async function auditSessionAdminAction(
  actor: Actor, session: { id: string; owner_user_id?: string | null } | undefined,
  action: AdminAuditAction, work: () => Promise<boolean | undefined>,
): Promise<void> {
  const audit = beginSessionAdminAudit(actor, session, action);
  try { audit.finish((await work()) ? 'succeeded' : 'failed'); }
  catch (error) { audit.finish('failed'); throw error; }
}

export function auditSessionAdminActionSync(
  actor: Actor, session: { id: string; owner_user_id?: string | null } | undefined,
  action: AdminAuditAction, work: () => boolean,
): void {
  const audit = beginSessionAdminAudit(actor, session, action);
  try { audit.finish(work() ? 'succeeded' : 'failed'); }
  catch (error) { audit.finish('failed'); throw error; }
}
