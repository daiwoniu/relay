import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { authenticateCookieHeader } from '../auth/middleware.js';
import {
  PutProjectApprovalTrustRequestSchema,
  PutSessionApprovalTrustRequestSchema,
  presentApiError,
  type ApprovalTrustStateDto,
  type ApprovalTrustUpdatedEvent,
} from '../contracts/index.js';
import type { ApprovalTrustService } from '../services/approval-trust.js';
import { presentApprovalTrustState } from '../contracts/index.js';
export { presentApprovalTrustState } from '../contracts/index.js';
import { canManageOwnedResource, type Actor } from '../auth/authorization.js';

const uuidSchema = z.string().uuid();

type ScopeRecord = { id: string; owner_user_id?: string | null; deleted_at?: number | null };
type SessionScopeRecord = ScopeRecord & { project_id?: string | null };

export function createApprovalTrustRouter(input: {
  service: ApprovalTrustService;
  authenticate?: typeof authenticateCookieHeader;
  getProject: (id: string) => ScopeRecord | undefined;
  getSession: (id: string) => SessionScopeRecord | undefined;
  getProjectMemberRole?: (projectId: string, userId: string) => string | null | undefined;
  broadcast: (event: ApprovalTrustUpdatedEvent, ownerUserId: string) => void;
}) {
  const router = new Hono();
  const authenticate = input.authenticate ?? authenticateCookieHeader;

  function requestActor(c: Context): Actor | Response {
    const user = authenticate(c.req.header('cookie'));
    return user ? { userId: user.id, role: user.role } : c.json(presentApiError('请先登录'), 401);
  }

  // 授权信任设置按登录账号单独存储，被授权项目成员可以对协作项目及自己创建会话
  // 维护自己的偏好，无需项目所有者身份。
  function canAccessScope(actor: Actor, kind: '项目' | '会话', scopeId: string, entity: ScopeRecord): boolean {
    if (canManageOwnedResource(actor, entity.owner_user_id)) return true;
    return kind === '项目' && Boolean(input.getProjectMemberRole?.(scopeId, actor.userId));
  }

  function scopeId(c: Context, actor: Actor, kind: '项目' | '会话'): string | Response {
    const parsed = uuidSchema.safeParse(c.req.param('id'));
    if (!parsed.success) return c.json(presentApiError(`${kind}标识无效`), 400);
    const entity = kind === '项目' ? input.getProject(parsed.data) : input.getSession(parsed.data);
    if (!entity || entity.deleted_at != null) return c.json(presentApiError(`${kind}不存在`), 404);
    if (kind === '会话') {
      const projectId = (entity as SessionScopeRecord).project_id;
      if (!projectId) return c.json(presentApiError('会话缺少项目归属'), 409);
      const project = input.getProject(projectId);
      if (!project || project.deleted_at != null) return c.json(presentApiError('会话所属项目不存在'), 404);
    }
    if (!canAccessScope(actor, kind, parsed.data, entity)) return c.json(presentApiError(`${kind}不存在`), 404);
    return parsed.data;
  }

  function failed(c: Context): Response {
    return c.json(presentApiError('授权信任设置处理失败'), 500);
  }

  function publish(actor: Actor, scope: 'project' | 'session', id: string): ApprovalTrustStateDto {
    const state = presentApprovalTrustState(scope === 'project'
      ? input.service.getProjectState(actor.userId, id)
      : input.service.getSessionState(actor.userId, id));
    try {
      input.broadcast({ type: 'approval_trust_updated', scope, scopeId: id }, actor.userId);
    } catch (error) {
      console.warn('[ApprovalTrust] 设置已提交，但多端状态广播失败:', error);
    }
    return state;
  }

  router.get('/projects/:id/approval-trust', (c) => {
    const actor = requestActor(c); if (actor instanceof Response) return actor;
    const id = scopeId(c, actor, '项目'); if (typeof id !== 'string') return id;
    try { return c.json(presentApprovalTrustState(input.service.getProjectState(actor.userId, id))); } catch { return failed(c); }
  });
  router.put('/projects/:id/approval-trust', async (c) => {
    const actor = requestActor(c); if (actor instanceof Response) return actor;
    const id = scopeId(c, actor, '项目'); if (typeof id !== 'string') return id;
    const body = PutProjectApprovalTrustRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(presentApiError('无效的项目信任参数'), 400);
    try { input.service.setProjectTrust(actor.userId, id, body.data.duration); return c.json(publish(actor, 'project', id)); } catch { return failed(c); }
  });
  router.delete('/projects/:id/approval-trust', (c) => {
    const actor = requestActor(c); if (actor instanceof Response) return actor;
    const id = scopeId(c, actor, '项目'); if (typeof id !== 'string') return id;
    try { input.service.clearProjectTrust(actor.userId, id); return c.json(publish(actor, 'project', id)); } catch { return failed(c); }
  });

  router.get('/sessions/:id/approval-trust', (c) => {
    const actor = requestActor(c); if (actor instanceof Response) return actor;
    const id = scopeId(c, actor, '会话'); if (typeof id !== 'string') return id;
    try { return c.json(presentApprovalTrustState(input.service.getSessionState(actor.userId, id))); } catch { return failed(c); }
  });
  router.put('/sessions/:id/approval-trust', async (c) => {
    const actor = requestActor(c); if (actor instanceof Response) return actor;
    const id = scopeId(c, actor, '会话'); if (typeof id !== 'string') return id;
    const body = PutSessionApprovalTrustRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(presentApiError('无效的会话信任参数'), 400);
    try {
      input.service.setSessionTrust(actor.userId, id, body.data.mode, body.data.duration);
      return c.json(publish(actor, 'session', id));
    } catch { return failed(c); }
  });
  router.delete('/sessions/:id/approval-trust', (c) => {
    const actor = requestActor(c); if (actor instanceof Response) return actor;
    const id = scopeId(c, actor, '会话'); if (typeof id !== 'string') return id;
    try { input.service.clearSessionTrust(actor.userId, id); return c.json(publish(actor, 'session', id)); } catch { return failed(c); }
  });

  return router;
}
