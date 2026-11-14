import {
  TrashProjectListResponseDtoSchema,
  TrashSessionListResponseDtoSchema,
  TrashRestoreResponseDtoSchema,
  TrashImpactDtoSchema,
  TrashDeleteResponseDtoSchema,
  presentProject,
  presentSession,
  type TrashProjectListResponseDto,
  type TrashSessionListResponseDto,
} from '../contracts/index.js';
import * as repository from '../db/queries-trash.js';
import type { DeletedProjectRow, DeletedSessionRow, TrashAttachmentCleanupJobInput, TrashPermanentDeletePlan, TrashPermanentDeleteResult, TrashListFilter, TrashMessageMatchRow, TrashProjectOptionRow } from '../db/queries-trash.js';
import type { Project, Session } from '../db/query-types.js';
import fs from 'node:fs';
import { v4 as uuid } from 'uuid';
import { projectUploadStore, UploadError, type QuarantinedProjectUploads } from '../uploads/project-uploads.js';
import { createTrashAttachmentCleanupService } from './trash-attachment-cleanup.js';
import { ServiceError } from './errors.js';
import { canManageOwnedResource, visibleOwnerUserId, type Actor } from '../auth/authorization.js';
import {
  recordAdminAudit,
  runAdminAuditedAction,
  runAdminAuditedExternalAction,
  runAdminAuditedExternalSyncAction,
  type AdminAuditInput,
} from '../db/admin-audit.js';
import { getArchivedCodexThreadIds, unarchiveCodexThreads } from '../codex/thread-admin.js';
import { syncCodexArchivedStatuses } from '../db/queries.js';
import { createMessageSearchSnippet, getMessages } from '../db/queries.js';

export interface TrashRepository {
  listDeletedProjects(limit: number, offset: number, ownerUserId?: string, filter?: TrashListFilter): DeletedProjectRow[];
  countDeletedProjects(ownerUserId?: string, filter?: TrashListFilter): number;
  listDeletedSessions(limit: number, offset: number, ownerUserId?: string, filter?: TrashListFilter): DeletedSessionRow[];
  countDeletedSessions(ownerUserId?: string, filter?: TrashListFilter): number;
  listSessionProjects(ownerUserId?: string): TrashProjectOptionRow[];
  getPreviewableSessionOwner(sessionId: string): { owner_user_id: string | null; project_owner_user_id: string | null } | undefined;
  listMessageMatches(sessionIds: string[], query: string): TrashMessageMatchRow[];
  listProjectMatchingSessions(projectIds: string[], query: string): Array<{ project_id: string; id: string; title: string; message_count: number }>;
  listSessionMatchPage(sessionId: string, query: string, offset: number): { items: Array<{ id: string; role: string; content: string; created_at: number }>; total: number };
  listProjectSessions(projectId: string, limit: number, offset: number, ownerUserId?: string): DeletedSessionRow[];
  countProjectSessions(projectId: string, ownerUserId?: string): number;
  getDeletedProject(projectId: string): Project | undefined;
  restoreProject(projectId: string): { project: Project; sessions: Session[] } | undefined;
  restoreSession(sessionId: string): Session | undefined;
  completeSessionTrashUnarchives(sessionIds: string[]): Session[];
  buildProjectPermanentDeletePlan(projectId: string): TrashPermanentDeletePlan | undefined;
  buildSessionPermanentDeletePlan(sessionId: string): TrashPermanentDeletePlan | undefined;
  permanentlyDeleteProject(projectId: string, cleanupJob?: TrashAttachmentCleanupJobInput): TrashPermanentDeleteResult;
  permanentlyDeleteSession(sessionId: string, cleanupJob?: TrashAttachmentCleanupJobInput): TrashPermanentDeleteResult;
}

const defaultRepository: TrashRepository = {
  listDeletedProjects: repository.listDeletedProjects,
  countDeletedProjects: repository.countDeletedProjects,
  listDeletedSessions: repository.listDeletedSessions,
  countDeletedSessions: repository.countDeletedSessions,
  listSessionProjects: repository.listTrashSessionProjects,
  getPreviewableSessionOwner: repository.getPreviewableTrashSessionOwner,
  listMessageMatches: repository.listTrashMessageMatches,
  listProjectMatchingSessions: repository.listTrashProjectMatchingSessions,
  listSessionMatchPage: repository.listTrashSessionMatchPage,
  listProjectSessions: repository.listProjectTrashSessions,
  countProjectSessions: repository.countProjectTrashSessions,
  getDeletedProject: repository.getDeletedProject,
  restoreProject: repository.restoreProjectFromTrash,
  restoreSession: repository.restoreSessionFromTrash,
  completeSessionTrashUnarchives: repository.completeSessionTrashUnarchives,
  buildProjectPermanentDeletePlan: repository.buildProjectPermanentDeletePlan,
  buildSessionPermanentDeletePlan: repository.buildSessionPermanentDeletePlan,
  permanentlyDeleteProject: repository.permanentlyDeleteProject,
  permanentlyDeleteSession: repository.permanentlyDeleteSession,
};

const presentTrashSession = (row: DeletedSessionRow) => ({
  id: row.id,
  title: row.title,
  projectId: row.project_id,
  projectName: row.project_name,
  engine: row.engine,
  deletedAt: Number(row.deleted_at),
  messageCount: Number(row.message_count),
});

export interface TrashFilesystemPort {
  realpath(projectPath: string): string;
  isDirectory(projectPath: string): boolean;
}

export interface TrashBroadcastPort {
  projectUpdated(project: ReturnType<typeof presentProject>, ownerUserId?: string | null): void;
  sessionUpdated(session: ReturnType<typeof presentSession>, ownerUserId?: string | null): void;
  projectDeleted(projectId: string, ownerUserId: string): void;
  sessionDeleted(sessionId: string, ownerUserId: string): void;
}

export interface TrashUploadPort {
  quarantineArchivedMessages(input: { projectPath: string; operationId: string; messageIds: string[] }): QuarantinedProjectUploads | undefined;
}

export interface TrashCleanupPort {
  cleanupOperation(operationId: string): boolean;
}

export interface TrashCodexThreadPort {
  unarchiveThreads(threadIds: string[]): Promise<{ succeeded: string[]; failed: Array<{ threadId: string; message: string }> }>;
}

const defaultFilesystem: TrashFilesystemPort = {
  realpath: fs.realpathSync,
  isDirectory: (projectPath) => fs.statSync(projectPath).isDirectory(),
};
const noBroadcast: TrashBroadcastPort = {
  projectUpdated: () => undefined,
  sessionUpdated: () => undefined,
  projectDeleted: () => undefined,
  sessionDeleted: () => undefined,
};

export function createTrashService(
  trashRepository: TrashRepository = defaultRepository,
  options: {
    filesystem?: TrashFilesystemPort;
    broadcast?: TrashBroadcastPort;
    sidebarChanged?: () => void;
    diagnostic?: (message: string) => void;
    uploads?: TrashUploadPort;
    cleanup?: TrashCleanupPort;
    operationId?: () => string;
    audit?: (input: AdminAuditInput) => boolean;
    codexThreads?: TrashCodexThreadPort;
    reconcileArchiveStatuses?: () => Promise<Session[]>;
  } = {},
) {
  const filesystem = options.filesystem ?? defaultFilesystem;
  const broadcast = options.broadcast ?? noBroadcast;
  const uploads = options.uploads ?? projectUploadStore;
  const cleanup = options.cleanup ?? { cleanupOperation: (id: string) => createTrashAttachmentCleanupService().cleanupOperation(id) };
  const operationId = options.operationId ?? uuid;
  const audit = options.audit ?? (trashRepository === defaultRepository ? recordAdminAudit : () => false);
  const codexThreads = options.codexThreads ?? { unarchiveThreads: unarchiveCodexThreads };
  const reconcileArchiveStatuses = options.reconcileArchiveStatuses ?? (async () => {
    return syncCodexArchivedStatuses([...await getArchivedCodexThreadIds({ force: true })]);
  });
  const useDefaultAudit = trashRepository === defaultRepository && audit === recordAdminAudit;
  const audited = <T>(input: AdminAuditInput, action: () => T): T => {
    if (useDefaultAudit) return runAdminAuditedAction(input, action);
    const result = action(); audit({ ...input, result: 'succeeded' }); return result;
  };
  const auditedExternal = <T>(input: AdminAuditInput, action: () => T): T => {
    if (useDefaultAudit) return runAdminAuditedExternalSyncAction(input, action);
    const result = action(); audit({ ...input, result: 'succeeded' }); return result;
  };
  const auditedExternalAsync = async <T>(input: AdminAuditInput, action: () => Promise<T>): Promise<T> => {
    if (useDefaultAudit) return runAdminAuditedExternalAction(input, action);
    const result = await action(); audit({ ...input, result: 'succeeded' }); return result;
  };
  const restoreArchivedThreads = async (sessions: Session[]) => {
    const candidates = sessions.filter((session) => session.codex_archived_for_trash && session.engine === 'codex' && session.codex_thread_id);
    if (candidates.length === 0) return { unarchivedSessionCount: 0, unarchiveFailedSessionCount: 0, archiveStateSyncFailedSessionCount: 0, presented: new Map<string, Session>() };
    const presented = new Map<string, Session>();
    const byThreadId = new Map<string, Session[]>();
    for (const session of candidates) {
      const sessionsForThread = byThreadId.get(session.codex_thread_id!) ?? [];
      sessionsForThread.push(session);
      byThreadId.set(session.codex_thread_id!, sessionsForThread);
    }
    let result: Awaited<ReturnType<TrashCodexThreadPort['unarchiveThreads']>>;
    try {
      result = await codexThreads.unarchiveThreads([...byThreadId.keys()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const session of candidates) options.diagnostic?.(`会话已恢复但取消 Codex 归档失败 ${session.id}：${message}`);
      return { unarchivedSessionCount: 0, unarchiveFailedSessionCount: candidates.length, archiveStateSyncFailedSessionCount: 0, presented };
    }
    const succeededSessions = result.succeeded.flatMap((threadId) => byThreadId.get(threadId) ?? []);
    const failedSessionCount = result.failed.reduce((count, failure) => count + (byThreadId.get(failure.threadId)?.length ?? 0), 0);
    for (const failure of result.failed) {
      const failedSessions = byThreadId.get(failure.threadId) ?? [];
      if (failedSessions.length === 0) options.diagnostic?.(`会话已恢复但取消 Codex 归档失败 ${failure.threadId}：${failure.message}`);
      for (const session of failedSessions) options.diagnostic?.(`会话已恢复但取消 Codex 归档失败 ${session.id}：${failure.message}`);
    }
    try {
      const updated = trashRepository.completeSessionTrashUnarchives(succeededSessions.map((session) => session.id));
      for (const session of updated) presented.set(session.id, session);
      if (updated.length !== succeededSessions.length) throw new Error('恢复标记已变化');
      return { unarchivedSessionCount: succeededSessions.length, unarchiveFailedSessionCount: failedSessionCount, archiveStateSyncFailedSessionCount: 0, presented };
    } catch (error) {
      options.diagnostic?.(`Codex 已取消归档但 Relay 状态落盘失败：${error instanceof Error ? error.message : String(error)}`);
      try {
        const reconciled = await reconcileArchiveStatuses();
        for (const session of reconciled) presented.set(session.id, session);
        return { unarchivedSessionCount: succeededSessions.length, unarchiveFailedSessionCount: failedSessionCount, archiveStateSyncFailedSessionCount: 0, presented };
      } catch (syncError) {
        options.diagnostic?.(`Codex 已取消归档但 Relay 状态同步失败：${syncError instanceof Error ? syncError.message : String(syncError)}`);
        return { unarchivedSessionCount: succeededSessions.length, unarchiveFailedSessionCount: failedSessionCount, archiveStateSyncFailedSessionCount: succeededSessions.length, presented };
      }
    }
  };
  const safeEffect = (message: string, effect: () => void) => {
    try { effect(); } catch (error) {
      options.diagnostic?.(`${message}：${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const rollbackQuarantine = (quarantined: QuarantinedProjectUploads | undefined) => {
    if (!quarantined) return;
    try {
      quarantined.rollback();
    } catch {
      options.diagnostic?.(`附件隔离回滚失败 ${quarantined.operationId}: UPLOAD_ROLLBACK_FAILED`);
    }
  };
  const quarantineArchivedMessages = (input: { projectPath: string; operationId: string; messageIds: string[] }) => {
    try {
      return uploads.quarantineArchivedMessages(input);
    } catch (error) {
      if (error instanceof UploadError && [400, 403, 404, 409, 422, 500].includes(error.status)) {
        throw new ServiceError(error.status as 400 | 403 | 404 | 409 | 422 | 500, error.message, error.code);
      }
      throw new ServiceError(409, '托管附件存储当前不可访问，请稍后重试', 'TRASH_ATTACHMENT_STORAGE_UNAVAILABLE');
    }
  };
  const cleanupQuarantine = (quarantined: QuarantinedProjectUploads | undefined): boolean => {
    if (!quarantined) return false;
    try {
      return !cleanup.cleanupOperation(quarantined.operationId);
    } catch {
      options.diagnostic?.(`附件清理调度失败 ${quarantined.operationId}: TRASH_CLEANUP_FAILED`);
      return true;
    }
  };
  const requireProjectForActor = (actor: Actor, projectId: string): Project => {
    const project = trashRepository.getDeletedProject(projectId);
    if (!project || project.is_system || !canManageOwnedResource(actor, project.owner_user_id)) throw new ServiceError(404, '回收站项目不存在');
    return project;
  };
  const requirePlanForActor = (actor: Actor, plan: TrashPermanentDeletePlan | undefined, resourceName: string): TrashPermanentDeletePlan => {
    if (!plan || !canManageOwnedResource(actor, plan.ownerUserId)) throw new ServiceError(404, `回收站${resourceName}不存在`);
    return plan;
  };
  const requirePreviewableSessionForActor = (actor: Actor, sessionId: string): void => {
    const owners = trashRepository.getPreviewableSessionOwner(sessionId);
    if (!owners || (!canManageOwnedResource(actor, owners.owner_user_id) && !canManageOwnedResource(actor, owners.project_owner_user_id))) {
      throw new ServiceError(404, '回收站会话不存在');
    }
  };
  return {
    listProjectsForActor(actor: Actor, limit: number, offset: number, filter: TrashListFilter = {}): TrashProjectListResponseDto {
      const ownerUserId = visibleOwnerUserId(actor);
      const rows = trashRepository.listDeletedProjects(limit, offset, ownerUserId, filter);
      const related = filter.query?.trim() ? trashRepository.listProjectMatchingSessions(rows.map((row) => row.id), filter.query) : [];
      const messages = filter.query?.trim() ? trashRepository.listMessageMatches(related.map((row) => row.id), filter.query) : [];
      const messageBySession = new Map(messages.map((row) => [row.session_id, row]));
      const matchByProject = new Map<string, (typeof related)[number]>();
      for (const row of related) if (!matchByProject.has(row.project_id) || (!messageBySession.has(matchByProject.get(row.project_id)!.id) && messageBySession.has(row.id))) matchByProject.set(row.project_id, row);
      return TrashProjectListResponseDtoSchema.parse({
        items: rows.map((row) => {
          const session = matchByProject.get(row.id);
          const message = session && messageBySession.get(session.id);
          return { id: row.id, name: row.name, path: row.path, deletedAt: Number(row.deleted_at), sessionCount: Number(row.session_count),
            ...(session ? { matchSessionId: session.id, matchSessionTitle: session.title, matchSessionMessageCount: Number(session.message_count) } : {}),
            ...(message ? { matchMessageId: message.id, matchCount: Number(message.match_count), matchSnippet: createMessageSearchSnippet(message.content, filter.query!).text } : {}) };
        }),
        total: trashRepository.countDeletedProjects(ownerUserId, filter), limit, offset,
      });
    },
    listSessionsForActor(actor: Actor, limit: number, offset: number, filter: TrashListFilter = {}): TrashSessionListResponseDto {
      const ownerUserId = visibleOwnerUserId(actor);
      const rows = trashRepository.listDeletedSessions(limit, offset, ownerUserId, filter);
      const matches = filter.query?.trim() ? trashRepository.listMessageMatches(rows.map((row) => row.id), filter.query) : [];
      const matchBySession = new Map(matches.map((row) => [row.session_id, row]));
      return TrashSessionListResponseDtoSchema.parse({ items: rows.map((row) => {
        const message = matchBySession.get(row.id);
        return { ...presentTrashSession(row), ...(message ? { matchMessageId: message.id, matchCount: Number(message.match_count), matchSnippet: createMessageSearchSnippet(message.content, filter.query!).text } : {}) };
      }), total: trashRepository.countDeletedSessions(ownerUserId, filter), limit, offset });
    },
    listSessionProjectsForActor(actor: Actor) { return trashRepository.listSessionProjects(visibleOwnerUserId(actor)); },
    listSessionMatchesForActor(actor: Actor, sessionId: string, query: string, offset: number) {
      requirePreviewableSessionForActor(actor, sessionId);
      const page = trashRepository.listSessionMatchPage(sessionId, query, offset);
      return { total: page.total, items: page.items.map((message) => ({ id: message.id, role: message.role, content: createMessageSearchSnippet(message.content, query, 1200).text, createdAt: Number(message.created_at) })) };
    },
    listProjectSessionsForActor(actor: Actor, projectId: string, limit: number, offset: number): TrashSessionListResponseDto {
      requireProjectForActor(actor, projectId);
      const ownerUserId = visibleOwnerUserId(actor);
      return TrashSessionListResponseDtoSchema.parse({ items: trashRepository.listProjectSessions(projectId, limit, offset, ownerUserId).map(presentTrashSession), total: trashRepository.countProjectSessions(projectId, ownerUserId), limit, offset });
    },
    listSessionPreviewForActor(actor: Actor, sessionId: string) {
      requirePreviewableSessionForActor(actor, sessionId);
      const allMessages = getMessages(sessionId, 500, 0);
      const userMessageIndexes = allMessages
        .map((message, index) => message.role === 'user' ? index : -1)
        .filter((index) => index >= 0);
      const firstRecentTurnIndex = userMessageIndexes.at(-5) ?? 0;
      const messages = allMessages.slice(firstRecentTurnIndex);
      return messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: String(message.content || '').trim().slice(0, 280),
        createdAt: Number(message.created_at),
      }));
    },
    listProjects(limit: number, offset: number): TrashProjectListResponseDto {
      return TrashProjectListResponseDtoSchema.parse({
        items: trashRepository.listDeletedProjects(limit, offset).map((row) => ({
          id: row.id,
          name: row.name,
          path: row.path,
          deletedAt: Number(row.deleted_at),
          sessionCount: Number(row.session_count),
        })),
        total: trashRepository.countDeletedProjects(), limit, offset,
      });
    },
    listSessions(limit: number, offset: number): TrashSessionListResponseDto {
      return TrashSessionListResponseDtoSchema.parse({
        items: trashRepository.listDeletedSessions(limit, offset).map(presentTrashSession),
        total: trashRepository.countDeletedSessions(), limit, offset,
      });
    },
    listProjectSessions(projectId: string, limit: number, offset: number): TrashSessionListResponseDto {
      return TrashSessionListResponseDtoSchema.parse({
        items: trashRepository.listProjectSessions(projectId, limit, offset).map(presentTrashSession),
        total: trashRepository.countProjectSessions(projectId), limit, offset,
      });
    },
    async restoreProject(projectId: string) {
      const project = trashRepository.getDeletedProject(projectId);
      if (!project || project.is_system) throw new ServiceError(404, '回收站项目不存在');
      try {
        const resolved = filesystem.realpath(project.path);
        if (!filesystem.isDirectory(resolved)) throw new Error('not a directory');
      } catch {
        throw new ServiceError(409, '原项目目录不存在或不可访问，请先恢复原目录', 'TRASH_PROJECT_PATH_UNAVAILABLE');
      }
      const restored = trashRepository.restoreProject(projectId);
      if (!restored) throw new ServiceError(409, '项目状态已变化，请刷新回收站', 'TRASH_ITEM_CHANGED');
      const unarchive = await restoreArchivedThreads(restored.sessions);
      safeEffect('项目已恢复但广播失败', () => broadcast.projectUpdated(presentProject(restored.project), restored.project.owner_user_id));
      for (const session of restored.sessions) {
        const current = unarchive.presented.get(session.id) ?? session;
        safeEffect('会话已恢复但广播失败', () => broadcast.sessionUpdated(presentSession(current), current.owner_user_id));
      }
      safeEffect('项目已恢复但侧栏刷新失败', () => options.sidebarChanged?.());
      return TrashRestoreResponseDtoSchema.parse({
        ok: true,
        restoredSessionCount: restored.sessions.length,
        unarchivedSessionCount: unarchive.unarchivedSessionCount,
        unarchiveFailedSessionCount: unarchive.unarchiveFailedSessionCount,
        archiveStateSyncFailedSessionCount: unarchive.archiveStateSyncFailedSessionCount,
      });
    },
    async restoreProjectForActor(actor: Actor, projectId: string) {
      const project = requireProjectForActor(actor, projectId);
      if (!project.owner_user_id) return this.restoreProject(projectId);
      return auditedExternalAsync({ actorUserId: actor.userId, action: 'project.restore', resourceType: 'project', resourceId: projectId, ownerUserId: project.owner_user_id }, () => this.restoreProject(projectId));
    },
    async restoreSession(sessionId: string) {
      const restored = trashRepository.restoreSession(sessionId);
      if (!restored) throw new ServiceError(404, '回收站会话不存在');
      const unarchive = await restoreArchivedThreads([restored]);
      const current = unarchive.presented.get(restored.id) ?? restored;
      safeEffect('会话已恢复但广播失败', () => broadcast.sessionUpdated(presentSession(current), current.owner_user_id));
      safeEffect('会话已恢复但侧栏刷新失败', () => options.sidebarChanged?.());
      return TrashRestoreResponseDtoSchema.parse({
        ok: true,
        restoredSessionCount: 1,
        unarchivedSessionCount: unarchive.unarchivedSessionCount,
        unarchiveFailedSessionCount: unarchive.unarchiveFailedSessionCount,
        archiveStateSyncFailedSessionCount: unarchive.archiveStateSyncFailedSessionCount,
      });
    },
    async restoreSessionForActor(actor: Actor, sessionId: string) {
      const plan = requirePlanForActor(actor, trashRepository.buildSessionPermanentDeletePlan(sessionId), '会话');
      if (!plan.ownerUserId) return this.restoreSession(sessionId);
      return auditedExternalAsync({ actorUserId: actor.userId, action: 'session.restore', resourceType: 'session', resourceId: sessionId, ownerUserId: plan.ownerUserId }, () => this.restoreSession(sessionId));
    },
    getProjectImpact(projectId: string) {
      const plan = trashRepository.buildProjectPermanentDeletePlan(projectId);
      if (!plan) throw new ServiceError(404, '回收站项目不存在');
      return TrashImpactDtoSchema.parse(plan.impact);
    },
    getProjectImpactForActor(actor: Actor, projectId: string) {
      return TrashImpactDtoSchema.parse(requirePlanForActor(actor, trashRepository.buildProjectPermanentDeletePlan(projectId), '项目').impact);
    },
    getSessionImpact(sessionId: string) {
      const plan = trashRepository.buildSessionPermanentDeletePlan(sessionId);
      if (!plan) throw new ServiceError(404, '回收站会话不存在');
      return TrashImpactDtoSchema.parse(plan.impact);
    },
    getSessionImpactForActor(actor: Actor, sessionId: string) {
      return TrashImpactDtoSchema.parse(requirePlanForActor(actor, trashRepository.buildSessionPermanentDeletePlan(sessionId), '会话').impact);
    },
    prepareProjectPermanentDelete(projectId: string, input: { impactRevision: string; confirmationName: string }) {
      const plan = trashRepository.buildProjectPermanentDeletePlan(projectId);
      if (!plan) throw new ServiceError(404, '回收站项目不存在');
      if (input.confirmationName !== plan.projectName) throw new ServiceError(422, '项目名称确认不匹配', 'TRASH_CONFIRMATION_MISMATCH');
      if (input.impactRevision !== plan.impact.impactRevision) throw new ServiceError(409, '删除影响已变化，请重新确认', 'TRASH_IMPACT_CHANGED');
      const quarantined = quarantineArchivedMessages({
        projectPath: plan.projectPath,
        operationId: operationId(),
        messageIds: plan.managedAttachmentMessageIds,
      });
      try {
        const result = trashRepository.permanentlyDeleteProject(projectId, quarantined ? {
          operationId: quarantined.operationId,
          quarantinePath: quarantined.quarantinePath,
          createdAt: Date.now(),
        } : undefined);
        if (result.status !== 'deleted') throw new ServiceError(409, '项目状态已变化，请刷新回收站', 'TRASH_ITEM_CHANGED');
      } catch (error) {
        rollbackQuarantine(quarantined);
        throw error;
      }
      const cleanupPending = cleanupQuarantine(quarantined);
      if (plan.ownerUserId) {
        safeEffect('项目已彻底删除但广播失败', () => broadcast.projectDeleted(plan.projectId, plan.ownerUserId!));
        for (const sessionId of plan.sessionIds) safeEffect('会话已彻底删除但广播失败', () => broadcast.sessionDeleted(sessionId, plan.ownerUserId!));
      }
      safeEffect('项目已彻底删除但侧栏刷新失败', () => options.sidebarChanged?.());
      return TrashDeleteResponseDtoSchema.parse({ ok: true, cleanupPending });
    },
    prepareProjectPermanentDeleteForActor(actor: Actor, projectId: string, input: { impactRevision: string; confirmationName: string }) {
      const plan = requirePlanForActor(actor, trashRepository.buildProjectPermanentDeletePlan(projectId), '项目');
      if (!plan.ownerUserId) return this.prepareProjectPermanentDelete(projectId, input);
      return auditedExternal({ actorUserId: actor.userId, action: 'project.permanent_delete', resourceType: 'project', resourceId: projectId, ownerUserId: plan.ownerUserId }, () => this.prepareProjectPermanentDelete(projectId, input));
    },
    prepareSessionPermanentDelete(sessionId: string, input: { impactRevision: string }) {
      const plan = trashRepository.buildSessionPermanentDeletePlan(sessionId);
      if (!plan) throw new ServiceError(404, '回收站会话不存在');
      if (input.impactRevision !== plan.impact.impactRevision) throw new ServiceError(409, '删除影响已变化，请重新确认', 'TRASH_IMPACT_CHANGED');
      const quarantined = quarantineArchivedMessages({
        projectPath: plan.projectPath,
        operationId: operationId(),
        messageIds: plan.managedAttachmentMessageIds,
      });
      try {
        const result = trashRepository.permanentlyDeleteSession(sessionId, quarantined ? {
          operationId: quarantined.operationId,
          quarantinePath: quarantined.quarantinePath,
          createdAt: Date.now(),
        } : undefined);
        if (result.status !== 'deleted') throw new ServiceError(409, '会话状态已变化，请刷新回收站', 'TRASH_ITEM_CHANGED');
      } catch (error) {
        rollbackQuarantine(quarantined);
        throw error;
      }
      const cleanupPending = cleanupQuarantine(quarantined);
      if (plan.ownerUserId) safeEffect('会话已彻底删除但广播失败', () => broadcast.sessionDeleted(plan.targetId, plan.ownerUserId!));
      safeEffect('会话已彻底删除但侧栏刷新失败', () => options.sidebarChanged?.());
      return TrashDeleteResponseDtoSchema.parse({ ok: true, cleanupPending });
    },
    prepareSessionPermanentDeleteForActor(actor: Actor, sessionId: string, input: { impactRevision: string }) {
      const plan = requirePlanForActor(actor, trashRepository.buildSessionPermanentDeletePlan(sessionId), '会话');
      if (!plan.ownerUserId) return this.prepareSessionPermanentDelete(sessionId, input);
      return auditedExternal({ actorUserId: actor.userId, action: 'session.permanent_delete', resourceType: 'session', resourceId: sessionId, ownerUserId: plan.ownerUserId }, () => this.prepareSessionPermanentDelete(sessionId, input));
    },
  };
}

export const trashService = createTrashService();
