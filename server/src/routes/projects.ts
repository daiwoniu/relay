import { Hono } from 'hono';
import { z } from 'zod';
import { ensureCodexThreadArchivedForDeletion } from '../codex/thread-admin.js';
import { ensureCodexProcessReady,releaseCodexProcessReady } from '../system/codex-lifecycle.js';
import * as queries from '../db/queries.js';
import { broadcastProjectDelete, broadcastProjectUpdate, broadcastUserFrontendEvent, closeEngineByProjectId, closeEngineBySessionId, interruptEngineBySessionId } from '../ws/frontend.js';
import { createProjectService } from '../services/projects.js';
import { createSessionDeletionCoordinator } from '../services/session-deletion.js';
import { respondServiceError } from './service-error.js';
import { OkDtoSchema, ProjectDeletionImpactDtoSchema, UserListResponseDtoSchema, presentApiError } from '../contracts/index.js';
import { createSidebarOrderService } from '../services/sidebar-order.js';
import { broadcastSidebarOrderUpdate } from '../ws/frontend.js';
import { getRequestActor, type RelayEnv } from '../auth/authorization.js';

const projects = new Hono<RelayEnv>();
const sidebarOrderService = createSidebarOrderService({ broadcast: { updated: broadcastSidebarOrderUpdate } });
const sessionDeletion = createSessionDeletionCoordinator({
  runtime: {
    interruptSession: interruptEngineBySessionId,
    closeSessionConnection: closeEngineBySessionId,
  },
  codexThreads: { archiveThread: threadId=>ensureCodexThreadArchivedForDeletion(threadId,{ensureReady:ensureCodexProcessReady,releaseReady:releaseCodexProcessReady}) },
  persistence: { markThreadArchived: queries.markSessionCodexArchivedForTrash },
});
const projectService = createProjectService({
  runtime: { closeProjectConnections: closeEngineByProjectId },
  broadcast: {
    projectUpdated: broadcastProjectUpdate,
    projectDeleted: broadcastProjectDelete,
    memberGranted: (project, userId) => broadcastUserFrontendEvent(userId, { type: 'project_updated', project }),
    memberRevoked: (projectId, userId) => broadcastUserFrontendEvent(userId, { type: 'project_deleted', projectId }),
  },
  sidebarOrder: { changed: () => { sidebarOrderService.refreshAll(); } },
  deletion: sessionDeletion,
});

const createProjectSchema = z.object({
  path: z.string().trim().min(1).max(2048),
  name: z.string().trim().min(1).max(100).optional(),
}).strict();

const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  pinned: z.union([z.literal(0), z.literal(1)]).optional(),
  deletion_protected: z.union([z.literal(0), z.literal(1)]).optional(),
}).strict().refine((body) => Object.keys(body).length > 0, '至少提供一个可更新字段');

const memberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['viewer', 'collaborator', 'manager']),
  can_view_sessions: z.union([z.literal(0), z.literal(1)]).optional(),
}).strict();

// List projects
projects.get('/', (c) => {
  return c.json(projectService.listForActor(getRequestActor(c)));
});

// Create project
projects.post('/', async (c) => {
  const parsed = createProjectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('无效的项目参数'), 400);
  try {
    const result = projectService.createForActor(getRequestActor(c), parsed.data);
    return c.json(result.project, result.created ? 201 : 200);
  } catch (error) {
    return respondServiceError(c, error);
  }
});

projects.get('/:id/deletion-impact', (c) => {
  try {
    return c.json(ProjectDeletionImpactDtoSchema.parse(projectService.getDeletionImpactForActor(getRequestActor(c), c.req.param('id'))));
  } catch (error) {
    return respondServiceError(c, error);
  }
});

projects.get('/:id/members', (c) => {
  try { return c.json(projectService.listMembersForActor(getRequestActor(c), c.req.param('id'))); }
  catch (error) { return respondServiceError(c, error); }
});

projects.get('/:id/members/candidates', (c) => {
  try {
    return c.json(UserListResponseDtoSchema.parse({ users: projectService.listMemberCandidatesForActor(getRequestActor(c), c.req.param('id')) }));
  } catch (error) { return respondServiceError(c, error); }
});

projects.put('/:id/members/:userId', async (c) => {
  const parsed = memberSchema.safeParse({ userId: c.req.param('userId'), ...(await c.req.json().catch(() => ({}))) });
  if (!parsed.success) return c.json(presentApiError('无效的项目成员参数'), 400);
  try {
    projectService.upsertMemberForActor(getRequestActor(c), c.req.param('id'), parsed.data);
    return c.json({ ok: true });
  } catch (error) { return respondServiceError(c, error); }
});

projects.delete('/:id/members/:userId', (c) => {
  try {
    projectService.removeMemberForActor(getRequestActor(c), c.req.param('id'), c.req.param('userId'));
    return c.json({ ok: true });
  } catch (error) { return respondServiceError(c, error); }
});

// Update project
projects.patch('/:id', async (c) => {
  const parsed = updateProjectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(presentApiError('无效的项目更新参数'), 400);
  try {
    projectService.updateForActor(getRequestActor(c), c.req.param('id'), parsed.data);
    return c.json(OkDtoSchema.parse({ ok: true }));
  } catch (error) {
    return respondServiceError(c, error);
  }
});

// Delete project
projects.delete('/:id', async (c) => {
  try {
    await projectService.deleteForActor(getRequestActor(c), c.req.param('id'));
    return c.json(OkDtoSchema.parse({ ok: true }));
  } catch (error) {
    return respondServiceError(c, error);
  }
});

export default projects;
