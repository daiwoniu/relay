import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { authenticateCookieHeader } from '../auth/middleware.js';
import {
  ProjectUploadDeleteResponseDtoSchema,
  ProjectUploadResponseDtoSchema,
  ProjectUploadsResponseDtoSchema,
  ProjectUploadUsageDtoSchema,
  presentApiError,
} from '../contracts/index.js';
import * as queries from '../db/queries.js';
import type { Project } from '../db/queries.js';
import { projectUploadStore, type ProjectUploadStore, UploadError } from '../uploads/project-uploads.js';
import { canManageOwnedResource } from '../auth/authorization.js';
import { runAdminAuditedExternalSyncAction, type AdminAuditInput } from '../db/admin-audit.js';

const uuidSchema = z.string().uuid();
const deleteManySchema = z.object({ attachmentIds: z.array(z.string().uuid()).min(1).max(10) }).strict();

type UploadStorePort = Pick<ProjectUploadStore,
  'writeUpload' | 'deleteTemporary' | 'getUsage' | 'listArchived' | 'deleteArchived' | 'hasInFlight' | 'cleanupStaleTemporaryUploads'>;

function decodeFileName(value: string | undefined): string | null {
  if (!value) return null;
  try { return decodeURIComponent(value); } catch { return null; }
}

async function* requestBody(stream: ReadableStream<Uint8Array> | null): AsyncGenerator<Uint8Array> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function uploadErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof UploadError) {
    return c.json(
      presentApiError(error.message, error.code ? { code: error.code } : undefined),
      error.status as 400 | 403 | 404 | 409 | 413 | 415 | 500,
    );
  }
  return c.json(presentApiError('上传文件处理失败'), 500);
}

export function createProjectUploadsRouter({
  store = projectUploadStore,
  getProject = queries.getProject,
  countActiveSessions = queries.countActiveSessionsByProject,
  authenticate = authenticateCookieHeader,
  auditedExternal = runAdminAuditedExternalSyncAction,
}: {
  store?: UploadStorePort;
  getProject?: (id: string) => Project | undefined;
  countActiveSessions?: (projectId: string) => number;
  authenticate?: typeof authenticateCookieHeader;
  auditedExternal?: <T>(input: AdminAuditInput, action: () => T) => T;
} = {}) {
  const router = new Hono();

  type AuthenticatedUser = NonNullable<ReturnType<typeof authenticate>>;
  type RouteContext =
    | { ok: false; response: Response }
    | { ok: true; user: AuthenticatedUser; project: Project; projectId: string };

  function context(c: Context): RouteContext {
    const user = authenticate(c.req.header('cookie'));
    if (!user) return { ok: false, response: c.json(presentApiError('请先登录'), 401) };
    const parsedProjectId = uuidSchema.safeParse(c.req.param('id'));
    if (!parsedProjectId.success) return { ok: false, response: c.json(presentApiError('项目标识无效'), 400) };
    const project = getProject(parsedProjectId.data);
    if (!project || !canManageOwnedResource({ userId: user.id, role: user.role }, project.owner_user_id)) {
      return { ok: false, response: c.json(presentApiError('项目不存在'), 404) };
    }
    return { ok: true, user, project, projectId: parsedProjectId.data };
  }

  router.post('/:id/uploads', async (c) => {
    const current = context(c);
    if (!current.ok) return current.response;
    const uploadId = c.req.header('x-relay-upload-id') || '';
    const messageId = c.req.header('x-relay-message-id') || '';
    const name = decodeFileName(c.req.header('x-relay-file-name'));
    const declaredSize = Number(c.req.header('x-relay-file-size'));
    const mimeType = c.req.header('content-type')?.split(';', 1)[0]?.trim() || 'application/octet-stream';
    if (!uuidSchema.safeParse(uploadId).success || !uuidSchema.safeParse(messageId).success || !name || !Number.isSafeInteger(declaredSize) || declaredSize < 0) {
      return c.json(presentApiError('上传请求头无效'), 400);
    }
    try {
      store.cleanupStaleTemporaryUploads(current.project.path);
      const attachment = await store.writeUpload({
        projectId: current.projectId,
        projectPath: current.project.path,
        userId: current.user.id,
        uploadId,
        messageId,
        name,
        mimeType,
        declaredSize,
        body: requestBody(c.req.raw.body),
      });
      return c.json(ProjectUploadResponseDtoSchema.parse({ attachment, usage: store.getUsage(current.project.path) }), 201);
    } catch (error) {
      return uploadErrorResponse(c, error);
    }
  });

  router.delete('/:id/uploads/drafts/:uploadId', (c) => {
    const current = context(c);
    if (!current.ok) return current.response;
    const uploadId = c.req.param('uploadId');
    if (!uuidSchema.safeParse(uploadId).success) return c.json(presentApiError('上传标识无效'), 400);
    try {
      const deletedCount = store.deleteTemporary(current.project.path, uploadId, current.user.id, current.projectId) ? 1 : 0;
      return c.json(ProjectUploadDeleteResponseDtoSchema.parse({ deletedCount, usage: store.getUsage(current.project.path) }));
    } catch (error) { return uploadErrorResponse(c, error); }
  });

  router.get('/:id/uploads/usage', (c) => {
    const current = context(c);
    if (!current.ok) return current.response;
    try {
      store.cleanupStaleTemporaryUploads(current.project.path);
      return c.json(ProjectUploadUsageDtoSchema.parse(store.getUsage(current.project.path)));
    }
    catch (error) { return uploadErrorResponse(c, error); }
  });

  router.get('/:id/uploads', (c) => {
    const current = context(c);
    if (!current.ok) return current.response;
    try {
      store.cleanupStaleTemporaryUploads(current.project.path);
      return c.json(ProjectUploadsResponseDtoSchema.parse({
        usage: store.getUsage(current.project.path),
        files: store.listArchived(current.project.path, current.user.role === 'admin' ? undefined : current.user.id, current.projectId),
        cleanupBlockedReason: countActiveSessions(current.projectId) > 0
          ? '项目存在运行中的会话，暂时无法清理上传文件'
          : store.hasInFlight(current.project.path)
            ? '项目存在正在上传的文件，暂时无法清理'
            : null,
      }));
    } catch (error) { return uploadErrorResponse(c, error); }
  });

  const ensureCleanupAllowed = (projectId: string, projectPath: string) => {
    if (countActiveSessions(projectId) > 0) throw new UploadError(409, '项目存在运行中的会话，暂时无法清理上传文件', 'PROJECT_ACTIVE');
    if (store.hasInFlight(projectPath)) throw new UploadError(409, '项目存在正在上传的文件，暂时无法清理', 'UPLOAD_IN_PROGRESS');
  };

  const cleanupUserId = (user: AuthenticatedUser) => user.role === 'admin' ? undefined : user.id;
  const deleteArchived = (current: Extract<RouteContext, { ok: true }>, attachmentIds?: string[]) => {
    const action = () => store.deleteArchived(
      current.project.path, attachmentIds, cleanupUserId(current.user), current.projectId,
    );
    if (!current.project.owner_user_id || current.project.owner_user_id === current.user.id) return action();
    return auditedExternal({
      actorUserId: current.user.id, action: 'project.upload_delete', resourceType: 'project',
      resourceId: current.projectId, ownerUserId: current.project.owner_user_id,
    }, action);
  };

  router.delete('/:id/uploads/:attachmentId', (c) => {
    const current = context(c);
    if (!current.ok) return current.response;
    const attachmentId = c.req.param('attachmentId');
    if (!uuidSchema.safeParse(attachmentId).success) return c.json(presentApiError('附件标识无效'), 400);
    try {
      ensureCleanupAllowed(current.projectId, current.project.path);
      const deletedCount = deleteArchived(current, [attachmentId]);
      return c.json(ProjectUploadDeleteResponseDtoSchema.parse({ deletedCount, usage: store.getUsage(current.project.path) }));
    } catch (error) { return uploadErrorResponse(c, error); }
  });

  router.post('/:id/uploads/delete', async (c) => {
    const current = context(c);
    if (!current.ok) return current.response;
    const parsed = deleteManySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(presentApiError('清理参数无效'), 400);
    try {
      ensureCleanupAllowed(current.projectId, current.project.path);
      const deletedCount = deleteArchived(current, parsed.data.attachmentIds);
      return c.json(ProjectUploadDeleteResponseDtoSchema.parse({ deletedCount, usage: store.getUsage(current.project.path) }));
    } catch (error) { return uploadErrorResponse(c, error); }
  });

  router.delete('/:id/uploads', (c) => {
    const current = context(c);
    if (!current.ok) return current.response;
    try {
      ensureCleanupAllowed(current.projectId, current.project.path);
      const deletedCount = deleteArchived(current);
      return c.json(ProjectUploadDeleteResponseDtoSchema.parse({ deletedCount, usage: store.getUsage(current.project.path) }));
    } catch (error) { return uploadErrorResponse(c, error); }
  });

  return router;
}

export default createProjectUploadsRouter();
