import { Hono } from 'hono';
import { z } from 'zod';
import * as queries from '../db/queries.js';
import { broadcastAuthenticatedFrontendEvent, broadcastSessionDelete, broadcastSessionDeletionProgress, broadcastSessionUpdate, closeEngineBySessionId, interruptEngineBySessionId } from '../ws/frontend.js';
import { createSessionService } from '../services/sessions.js';
import { createSessionDeletionCoordinator } from '../services/session-deletion.js';
import { respondServiceError } from './service-error.js';
import { EngineIdSchema, OkDtoSchema, SessionDeletionImpactDtoSchema, SessionUpdateResponseDtoSchema, presentApiError, type FrontendEvent, type SessionDto } from '../contracts/index.js';
import {
  ensureCodexThreadArchivedForDeletion,
  getCachedArchivedCodexThreadIds,
  refreshArchivedCodexThreadIdsInBackground,
} from '../codex/thread-admin.js';
import { createSidebarOrderService } from '../services/sidebar-order.js';
import { ensureCodexProcessReady,releaseCodexProcessReady } from '../system/codex-lifecycle.js';
import { broadcastSidebarOrderUpdate } from '../ws/frontend.js';
import type { EngineModelCatalog } from '../engine/models/types.js';
import type { EngineId } from '../engine/types.js';
import { defaultEngineSystem } from '../engine/default-system.js';
import { EnginePreferencesValidationError, isEnginePreferencesLockedStatus, validateEnginePreferences } from '../engine/models/preferences.js';
import { createSessionForkService } from '../services/session-fork.js';
import { getRequestActor, type Actor, type RelayEnv } from '../auth/authorization.js';

const sessions = new Hono<RelayEnv>();
const sidebarOrderService = createSidebarOrderService({ broadcast: { updated: broadcastSidebarOrderUpdate } });
const sessionDeletion = createSessionDeletionCoordinator({
  runtime: {
    interruptSession: interruptEngineBySessionId,
    closeSessionConnection: closeEngineBySessionId,
  },
  codexThreads: { archiveThread: threadId=>ensureCodexThreadArchivedForDeletion(threadId,{ensureReady:ensureCodexProcessReady,releaseReady:releaseCodexProcessReady}) },
  persistence: { markThreadArchived: queries.markSessionCodexArchivedForTrash },
});
const sessionService = createSessionService({
  runtime: { closeSessionConnection: closeEngineBySessionId },
  deletion: sessionDeletion,
  broadcast: {
    sessionUpdated: broadcastSessionUpdate,
    sessionDeleted: broadcastSessionDelete,
    sessionDeletionProgress: broadcastSessionDeletionProgress,
  },
  sidebarOrder: { changed: () => { sidebarOrderService.refreshAll(); } },
});
const sessionForkService = createSessionForkService({
  engineSessions: { zcode: defaultEngineSystem.registry.get('zcode').sessions! },
  broadcast: { sessionUpdated: broadcastSessionUpdate },
  sidebarOrder: { changed: () => { sidebarOrderService.refreshAll(); } },
});

const createSessionSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  projectId: z.string().uuid().nullable().optional(),
  engine: EngineIdSchema.nullable().optional(),
}).strict();

const forkSessionSchema = z.object({
  messageId: z.string().uuid().optional(),
}).strict();

export function createSessionForkRouter(dependencies: {
  forkForActor(actor: Actor, sourceSessionId: string, input: { messageId?: string }): Promise<SessionDto>;
}) {
  const router = new Hono<RelayEnv>();
  router.post('/:id/fork', async (c) => {
    const parsed = forkSessionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(presentApiError('无效的创建新会话参数'), 400);
    try {
      return c.json(SessionUpdateResponseDtoSchema.parse({
        ok: true,
        session: await dependencies.forkForActor(getRequestActor(c), c.req.param('id'), parsed.data),
      }), 201);
    } catch (error) {
      return respondServiceError(c, error);
    }
  });
  return router;
}

const updateSessionSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  pinned: z.union([z.literal(0), z.literal(1)]).optional(),
  archived: z.union([z.literal(0), z.literal(1)]).optional(),
  project_id: z.string().uuid().nullable().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, '至少提供一个可更新字段');

const enginePreferencesSchema = z.object({
  modelId: z.string().trim().min(1).max(200).nullable(),
  reasoningEffort: z.string().trim().min(1).max(64).nullable(),
  serviceTier: z.string().trim().min(1).max(64).nullable().optional(),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export interface EnginePreferencesRouterDependencies {
  getSession(id: string): SessionDto | undefined;
  getCatalog(engineId: EngineId): Promise<EngineModelCatalog>;
  updatePreferences(
    actor: Actor,
    id: string,
    input: { modelId: string | null; reasoningEffort: string | null; serviceTier?: string | null; expectedRevision: number },
  ): SessionDto;
  broadcast(event: FrontendEvent): void;
  diagnostic?(message: string): void;
}

export function createEnginePreferencesRouter(dependencies: EnginePreferencesRouterDependencies) {
  const router = new Hono<RelayEnv>();
  router.patch('/:id/engine-preferences', async (c) => {
    const parsed = enginePreferencesSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(presentApiError('无效的模型偏好参数'), 400);
    const current = dependencies.getSession(c.req.param('id'));
    if (!current) return c.json(presentApiError('会话不存在'), 404);
    if (isEnginePreferencesLockedStatus(current.status)) {
      return c.json(presentApiError('会话正在运行，暂时不能切换模型', { code: 'SESSION_ENGINE_PREFERENCES_LOCKED' }), 409);
    }
    if (!current.engine) {
      return c.json(presentApiError('未绑定引擎的草稿请在首次发送时保存模型偏好', { code: 'SESSION_ENGINE_NOT_BOUND' }), 409);
    }

    try {
      const catalog = await dependencies.getCatalog(current.engine);
      const preferences = {
        ...parsed.data,
        serviceTier: parsed.data.serviceTier === undefined
          ? parsed.data.modelId === current.engine_preferences.modelId ? current.engine_preferences.serviceTier ?? null : null
          : parsed.data.serviceTier,
      };
      validateEnginePreferences(catalog, preferences);
      const updated = dependencies.updatePreferences(getRequestActor(c), c.req.param('id'), preferences);
      try {
        dependencies.broadcast({
          type: 'engine_preferences_updated', sessionId: updated.id,
          preferences: updated.engine_preferences,
        });
      } catch (error) {
        dependencies.diagnostic?.(`模型偏好已保存，但广播失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return c.json(SessionUpdateResponseDtoSchema.parse({ ok: true, session: updated }));
    } catch (error) {
      if (error instanceof EnginePreferencesValidationError) {
        return c.json(presentApiError(error.message, { code: error.code }), 422);
      }
      return respondServiceError(c, error);
    }
  });
  return router;
}

const searchQuerySchema = z.string().trim().min(1).max(100);

const messagePageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  knownRevision: z.coerce.number().int().nonnegative().optional(),
  beforeCreatedAt: z.coerce.number().int().nonnegative().optional(),
  beforeId: z.string().min(1).optional(),
}).strict().superRefine((value, context) => {
  if ((value.beforeCreatedAt === undefined) !== (value.beforeId === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '历史消息游标不完整' });
  }
});

function parsePagination(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(0, parsed)) : fallback;
}

export interface SessionListRouterDependencies {
  readCachedArchivedThreadIds(): Set<string> | null;
  refreshArchivedThreadIdsInBackground(options: {
    onSuccess?: (threadIds: Set<string>) => void;
    onError?: (error: Error) => void;
  }): boolean;
  syncCodexArchiveStatuses(threadIds: Set<string>): void;
  listForActor(actor: Actor, limit: number, offset: number, projectId?: string): SessionDto[];
  diagnostic(message: string): void;
}

export function createSessionListRouter(dependencies: SessionListRouterDependencies) {
  const router = new Hono<RelayEnv>();
  router.get('/', (c) => {
    const limit = parsePagination(c.req.query('limit'), 50, 500);
    const offset = parsePagination(c.req.query('offset'), 0, 100_000);
    const projectId = c.req.query('projectId') || undefined;
    try {
      const cachedArchivedThreadIds = dependencies.readCachedArchivedThreadIds();
      if (cachedArchivedThreadIds) dependencies.syncCodexArchiveStatuses(cachedArchivedThreadIds);
    } catch (error) {
      dependencies.diagnostic(`同步 Codex 归档缓存失败：${error instanceof Error ? error.message : String(error)}`);
    }
    dependencies.refreshArchivedThreadIdsInBackground({
      onSuccess: (threadIds) => { dependencies.syncCodexArchiveStatuses(threadIds); },
      onError: (error) => { dependencies.diagnostic(`后台同步 Codex 归档状态失败：${error.message}`); },
    });
    try {
      return c.json(dependencies.listForActor(getRequestActor(c), limit, offset, projectId));
    } catch (error) {
      return respondServiceError(c, error);
    }
  });
  return router;
}

// List sessions (支持按 projectId 过滤)
sessions.route('/', createSessionListRouter({
  readCachedArchivedThreadIds: getCachedArchivedCodexThreadIds,
  refreshArchivedThreadIdsInBackground: refreshArchivedCodexThreadIdsInBackground,
  syncCodexArchiveStatuses: (threadIds) => { sessionService.syncCodexArchiveStatuses(threadIds); },
  listForActor: (actor, limit, offset, projectId) => sessionService.listForActor(actor, limit, offset, projectId),
  diagnostic: (message) => { console.warn(`[Relay] ${message}`); },
}));

sessions.get('/search', (c) => {
  const parsed = searchQuerySchema.safeParse(c.req.query('q'));
  if (!parsed.success) return c.json(presentApiError('搜索词长度必须为 1–100 个字符'), 400);
  return c.json(sessionService.searchForActor(getRequestActor(c), parsed.data, parsePagination(c.req.query('limit'), 50, 100)));
});

sessions.get('/:id/search-matches', (c) => {
  const parsed = searchQuerySchema.safeParse(c.req.query('q'));
  if (!parsed.success) return c.json(presentApiError('搜索词长度必须为 1–100 个字符'), 400);
  try {
    sessionService.requireForActor(getRequestActor(c), c.req.param('id'));
    return c.json(sessionService.searchMessages(
      c.req.param('id'),
      parsed.data,
      parsePagination(c.req.query('limit'), 500, 500),
      {
        includeProcess: c.req.query('includeProcess') === '1',
        includeOperations: c.req.query('includeOperations') === '1',
      },
    ));
  } catch (error) {
    return respondServiceError(c, error);
  }
});

sessions.use('/:id/*', async (c, next) => {
  try {
    sessionService.requireForActor(getRequestActor(c), c.req.param('id'));
    return next();
  } catch (error) {
    return respondServiceError(c, error);
  }
});

// Create session
sessions.post('/', async (c) => {
  const parsed = createSessionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(presentApiError('无效的会话参数'), 400);
  try {
    return c.json(sessionService.createForActor(getRequestActor(c), parsed.data), 201);
  } catch (error) {
    return respondServiceError(c, error);
  }
});

sessions.route('/', createSessionForkRouter(sessionForkService));

// Get session deletion impact before the generic /:id route.
sessions.get('/:id/deletion-impact', (c) => {
  try {
    return c.json(SessionDeletionImpactDtoSchema.parse(sessionService.getDeletionImpactForActor(getRequestActor(c), c.req.param('id'))));
  } catch (error) {
    return respondServiceError(c, error);
  }
});

// Get session
sessions.get('/:id', (c) => {
  try {
    return c.json(sessionService.requireDetailsForActor(getRequestActor(c), c.req.param('id')));
  } catch (error) {
    return respondServiceError(c, error);
  }
});

// Update session
sessions.patch('/:id', async (c) => {
  const parsed = updateSessionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('无效的会话更新参数'), 400);
  try {
    return c.json(SessionUpdateResponseDtoSchema.parse({
      ok: true,
      session: sessionService.updateForActor(getRequestActor(c), c.req.param('id'), parsed.data),
    }));
  } catch (error) {
    return respondServiceError(c, error);
  }
});

sessions.route('/', createEnginePreferencesRouter({
  getSession: (id) => sessionService.get(id),
  getCatalog: (engineId) => defaultEngineSystem.modelCatalog.get(engineId),
  updatePreferences: (actor, id, input) => sessionService.updateEnginePreferencesForActor(actor, id, input),
  broadcast: broadcastAuthenticatedFrontendEvent,
  diagnostic: (message) => console.warn(`[Relay] ${message}`),
}));

sessions.post('/:id/unarchive', async (c) => {
  try {
    return c.json(SessionUpdateResponseDtoSchema.parse({
      ok: true,
      session: await sessionService.unarchiveCodexForActor(getRequestActor(c), c.req.param('id')),
    }));
  } catch (error) {
    return respondServiceError(c, error);
  }
});

// Delete session
sessions.delete('/:id', async (c) => {
  try {
    await sessionService.deleteForActor(getRequestActor(c), c.req.param('id'));
    return c.json(OkDtoSchema.parse({ ok: true }));
  } catch (error) {
    return respondServiceError(c, error);
  }
});

// Get a stable cursor page for a session
sessions.get('/:id/message-page', (c) => {
  const parsed = messagePageQuerySchema.safeParse({
    limit: c.req.query('limit') ?? undefined,
    knownRevision: c.req.query('knownRevision') ?? undefined,
    beforeCreatedAt: c.req.query('beforeCreatedAt') ?? undefined,
    beforeId: c.req.query('beforeId') ?? undefined,
  });
  if (!parsed.success) return c.json(presentApiError('无效的消息分页参数'), 400);
  const cursor = parsed.data.beforeCreatedAt !== undefined && parsed.data.beforeId !== undefined
    ? { beforeCreatedAt: parsed.data.beforeCreatedAt, beforeId: parsed.data.beforeId }
    : null;
  try {
    c.header('Cache-Control', 'private, no-store');
    return c.json(sessionService.listMessagePage(
      c.req.param('id'),
      parsed.data.limit,
      cursor,
      parsed.data.knownRevision,
    ));
  } catch (error) {
    return respondServiceError(c, error);
  }
});

// Get sanitized heavy details for one message
sessions.get('/:id/messages/:messageId/details', (c) => {
  try {
    c.header('Cache-Control', 'private, no-store');
    return c.json(sessionService.getMessageDetails(c.req.param('id'), c.req.param('messageId')));
  } catch (error) {
    return respondServiceError(c, error);
  }
});

// Get messages for a session
sessions.get('/:id/messages', (c) => {
  const limit = parsePagination(c.req.query('limit'), 30, 500);
  const offset = parsePagination(c.req.query('offset'), 0, 100_000);
  const includeDetails = c.req.query('details') !== '0';
  try {
    c.header('Cache-Control', 'private, no-store');
    return c.json(sessionService.listMessages(c.req.param('id'), limit, offset, includeDetails));
  } catch (error) {
    return respondServiceError(c, error);
  }
});

export default sessions;
