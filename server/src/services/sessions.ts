import * as queries from '../db/queries.js';
import { v4 as uuid } from 'uuid';
import { unarchiveCodexThread } from '../codex/thread-admin.js';
import type {
  EngineId,
  EngineTerminalProjectionRecord,
  EngineTerminalProjectionResult,
  Message,
  MessageCursor,
  MessagePageRecord,
  NewMessageRecord,
  Project,
  SavedMessageRecord,
  Session,
  SessionMessageSearchOptions,
  SessionMessageSearchPageRecord,
  SessionSearchRecord,
} from '../db/queries.js';
import {
  MessagePageResultDtoSchema,
  MessageDetailsDtoSchema,
  SessionMessageMatchesResponseDtoSchema,
  SessionSearchResponseDtoSchema,
  TokenUsageDtoSchema,
  presentSession,
  presentSessionDetails,
  type MessageDto,
  type MessageDetailsDto,
  type MessagePageResultDto,
  type SessionDto,
  type SessionDetailsDto,
  type SessionDeletionImpactDto,
  type SessionMessageMatchesResponseDto,
  type SessionSearchResponseDto,
  type SessionStatus,
  type TokenUsageDto,
} from '../contracts/index.js';
import { presentMessage, presentMessageSummary } from '../messages/presenter.js';
import { ServiceError } from './errors.js';
import { isSessionInProgress } from './session-runtime-status.js';
import { isEnginePreferencesLockedStatus } from '../engine/models/preferences.js';
import type { SessionDeletionProgressListener, SessionDeletionProgressStage, SessionDeletionRecord } from './session-deletion.js';
import { deletionState as sharedDeletionState, type DeletionState } from './deletion-state.js';
import { canManageOwnedResource, requireOwnedResource, visibleOwnerUserId, type Actor } from '../auth/authorization.js';
import { recordAdminAudit, runAdminAuditedAction, runAdminAuditedExternalAction, type AdminAuditInput } from '../db/admin-audit.js';
import type { User } from '../db/queries.js';

type SessionUpdates = Partial<Pick<Session, 'title' | 'pinned' | 'archived' | 'project_id' | 'status'>>;
type SessionPersistenceUpdates = SessionUpdates & Partial<Pick<Session, 'title_manually_set'>>;
type NewMessage = NewMessageRecord;

export interface SessionRepository {
  listSessions(limit?: number, offset?: number, projectId?: string): Session[];
  listSessionsForActor?(ownerUserId: string | undefined, limit?: number, offset?: number, projectId?: string): Session[];
  createSession(title?: string, projectId?: string, titleManuallySet?: boolean, engine?: EngineId | null, ownerUserId?: string | null): Session;
  getSession(id: string): Session | undefined;
  getSessionForActor?(id: string, ownerUserId?: string): Session | undefined;
  bindSessionEngine?(id: string, engine: EngineId): { session: Session; newlyBound: boolean };
  unbindSessionEngine?(id: string, engine: EngineId): void;
  updateSession(id: string, updates: SessionPersistenceUpdates): void;
  updateEnginePreferences?(
    id: string,
    input: { modelId: string | null; reasoningEffort: string | null; serviceTier?: string | null; expectedRevision: number },
  ): Session | undefined;
  deleteSession(id: string): void;
  getProject(id: string): Project | undefined;
  getProjectForActor?(id: string, ownerUserId?: string): Project | undefined;
  getProjectMemberRole?(projectId: string, userId: string): 'viewer' | 'collaborator' | 'manager' | null;
  getDefaultProject(): Project | undefined;
  getUserDefaultProject?(userId: string): Project | undefined;
  getProjectByPathForOwner?(projectPath: string, ownerUserId: string): Project | undefined;
  createProject?(name: string, projectPath: string, isSystem?: boolean, ownerUserId?: string | null): Project;
  getUserById?(id: string): User | undefined;
  getMessages(sessionId: string, limit?: number, offset?: number): Message[];
  getMessage(sessionId: string, messageId: string): Message | undefined;
  getMessagePage(sessionId: string, limit?: number, cursor?: MessageCursor | null): MessagePageRecord;
  getMessageRevision(sessionId: string): number;
  searchSessions(query: string, limit?: number): SessionSearchRecord[];
  searchSessionsForActor?(query: string, limit?: number, ownerUserId?: string): SessionSearchRecord[];
  searchSessionMessages(sessionId: string, query: string, limit?: number, options?: SessionMessageSearchOptions): SessionMessageSearchPageRecord;
  saveMessage(message: NewMessage): SavedMessageRecord;
  saveMessages(messages: NewMessage[]): SavedMessageRecord[];
  projectEngineTerminal?(input: EngineTerminalProjectionRecord): EngineTerminalProjectionResult;
  setSessionCodexThreadId(id: string, threadId: string): void;
  setSessionEngineSessionId?(id: string, engine: EngineId, externalSessionId: string): void;
  setSessionTokenUsage(id: string, usage: TokenUsageDto): void;
  incrementSessionContextCompactionCount?(id: string, event: { threadId: string; turnId: string }): { count: number; incremented: boolean };
  setSessionActiveTurnUsage(id: string, usage: TokenUsageDto | null): void;
  setSessionActiveTurn?(id: string, turnId: string | null, startedAt: number | null): void;
  setSessionActiveAttempt?(id: string, attemptId: string | null): void;
  setSessionCodexArchived(id: string, archived: boolean): void;
  syncCodexArchivedStatuses(archivedThreadIds: string[]): Session[];
}

export interface SessionRuntimePort {
  closeSessionConnection(sessionId: string): void;
}

export interface SessionBroadcastPort {
  sessionUpdated(session: SessionDto, ownerUserId?: string | null): void;
  sessionDeleted(sessionId: string, ownerUserId: string): void;
  sessionDeletionProgress?(sessionId: string, stage: SessionDeletionProgressStage | null, ownerUserId: string): void;
}

export interface SessionCodexThreadPort {
  unarchiveThread(threadId: string): Promise<void>;
}

export interface SessionDeletionPort {
  prepare(session: SessionDeletionRecord, onProgress?: SessionDeletionProgressListener): Promise<void>;
}

export interface SessionSidebarOrderPort {
  changed(): void;
}

const noSessionRuntime: SessionRuntimePort = { closeSessionConnection: () => undefined };
const noSessionBroadcast: SessionBroadcastPort = {
  sessionUpdated: () => undefined,
  sessionDeleted: () => undefined,
};
const defaultCodexThreads: SessionCodexThreadPort = { unarchiveThread: unarchiveCodexThread };
const noSessionDeletion: SessionDeletionPort = { prepare: async () => undefined };
const noSessionSidebarOrder: SessionSidebarOrderPort = { changed: () => undefined };

export function createSessionService({
  repository = queries,
  runtime = noSessionRuntime,
  broadcast = noSessionBroadcast,
  codexThreads = defaultCodexThreads,
  deletion = noSessionDeletion,
  deletionState = sharedDeletionState,
  audit = repository === queries ? recordAdminAudit : () => false,
  sidebarOrder = noSessionSidebarOrder,
}: {
  repository?: SessionRepository;
  runtime?: SessionRuntimePort;
  broadcast?: SessionBroadcastPort;
  codexThreads?: SessionCodexThreadPort;
  deletion?: SessionDeletionPort;
  deletionState?: DeletionState;
  audit?: (input: AdminAuditInput) => boolean;
  sidebarOrder?: SessionSidebarOrderPort;
} = {}) {
  const useDefaultAudit = repository === queries && audit === recordAdminAudit;
  const audited = <T>(input: AdminAuditInput, action: () => T): T => {
    if (useDefaultAudit) return runAdminAuditedAction(input, action);
    const result = action();
    audit({ ...input, result: 'succeeded' });
    return result;
  };
  const auditedExternal = async <T>(input: AdminAuditInput, action: () => Promise<T>): Promise<T> => {
    if (useDefaultAudit) return runAdminAuditedExternalAction(input, action);
    const result = await action();
    audit({ ...input, result: 'succeeded' });
    return result;
  };
  const requireSession = (id: string): Session => {
    const session = repository.getSession(id);
    if (!session) throw new ServiceError(404, '会话不存在');
    return session;
  };

  const requireProject = (id: string): void => {
    if (!repository.getProject(id)) throw new ServiceError(400, '项目不存在');
  };

  const resolveProjectId = (id?: string | null): string => {
    if (id) {
      requireProject(id);
      return id;
    }
    const defaultProject = repository.getDefaultProject();
    if (!defaultProject) throw new ServiceError(500, '默认项目不存在');
    return defaultProject.id;
  };

  const presentOwnedSession = (session: Session): SessionDto => presentSession(
    session,
    session.owner_user_id ? repository.getUserById?.(session.owner_user_id) : null,
  );

  const requireSessionForActor = (actor: Actor, id: string): Session => {
    const ownerUserId = visibleOwnerUserId(actor);
    const session = repository.getSessionForActor
      ? repository.getSessionForActor(id, ownerUserId)
      : repository.getSession(id);
    if (!session) throw new ServiceError(404, '会话不存在');
    if (canManageOwnedResource(actor, session.owner_user_id)) return session;
    const project = session.project_id ? repository.getProject(session.project_id) : undefined;
    if (project?.owner_user_id === actor.userId) return session;
    if (session.project_id && repository.getProjectMemberRole?.(session.project_id, actor.userId)) return session;
    throw new ServiceError(404, '会话不存在');
  };

  const requireOwnedSessionForActor = (actor: Actor, id: string): Session => {
    const session = requireSessionForActor(actor, id);
    if (!canManageOwnedResource(actor, session.owner_user_id)) {
      throw new ServiceError(403, '只能修改或删除自己创建的会话', 'SESSION_MANAGE_FORBIDDEN');
    }
    return session;
  };

  const resolveProjectForOwner = (actor: Actor, ownerUserId: string, id?: string | null): Project => {
    if (!id) {
      const defaultProject = repository.getUserDefaultProject?.(ownerUserId);
      if (!defaultProject) throw new ServiceError(500, '默认项目不存在');
      if (defaultProject.owner_user_id === ownerUserId) return defaultProject;
      const defaultRole = repository.getProjectMemberRole?.(defaultProject.id, ownerUserId);
      if (defaultRole === 'collaborator' || defaultRole === 'manager') return defaultProject;
      throw new ServiceError(500, '默认项目不存在');
    }
    const requested = repository.getProjectForActor
      ? repository.getProjectForActor(id, actor.role === 'admin' ? undefined : actor.userId)
      : repository.getProject(id);
    if (!requested) throw new ServiceError(404, '项目不存在');
    if (requested.owner_user_id === ownerUserId) return requested;
    if (actor.role === 'admin') {
      const ownProject = repository.getProjectByPathForOwner?.(requested.path, ownerUserId);
      if (ownProject && !ownProject.deleted_at) return ownProject;
      if (!repository.createProject) throw new ServiceError(500, '同目录项目创建能力不可用');
      return repository.createProject(requested.name, requested.path, false, ownerUserId);
    }
    const role = repository.getProjectMemberRole?.(requested.id, actor.userId);
    if (role === 'collaborator' || role === 'manager') return requested;
    throw new ServiceError(403, '没有权限在该项目中创建会话', 'SESSION_CREATE_FORBIDDEN');
  };

  return {
    listForActor(actor: Actor, limit = 50, offset = 0, projectId?: string): SessionDto[] {
      if (projectId) {
        const project = repository.getProjectForActor
          ? repository.getProjectForActor(projectId, actor.role === 'admin' ? undefined : actor.userId)
          : repository.getProject(projectId);
        if (!project) throw new ServiceError(404, '项目不存在');
      }
      const ownerUserId = visibleOwnerUserId(actor);
      const sessions = repository.listSessionsForActor
        ? repository.listSessionsForActor(ownerUserId, limit, offset, projectId)
        : repository.listSessions(limit, offset, projectId).filter((session) => canManageOwnedResource(actor, session.owner_user_id));
      return sessions.map(presentOwnedSession);
    },

    getForActor(actor: Actor, id: string): SessionDto | undefined {
      try { return presentOwnedSession(requireSessionForActor(actor, id)); } catch { return undefined; }
    },

    requireForActor(actor: Actor, id: string): SessionDto {
      return presentOwnedSession(requireSessionForActor(actor, id));
    },

    requireUsableForActor(actor: Actor, id: string): SessionDto {
      const session = requireSessionForActor(actor, id);
      if (canManageOwnedResource(actor, session.owner_user_id)) return presentOwnedSession(session);
      const project = session.project_id ? repository.getProject(session.project_id) : undefined;
      if (project?.owner_user_id === actor.userId) return presentOwnedSession(session);
      const role = session.project_id ? repository.getProjectMemberRole?.(session.project_id, actor.userId) : null;
      if (role === 'collaborator' || role === 'manager') return presentOwnedSession(session);
      throw new ServiceError(403, '当前项目为只读权限', 'SESSION_USE_FORBIDDEN');
    },

    requireDetailsForActor(actor: Actor, id: string): SessionDetailsDto {
      const session = requireSessionForActor(actor, id);
      return presentSessionDetails(session, session.owner_user_id ? repository.getUserById?.(session.owner_user_id) : null);
    },

    getDeletionImpactForActor(actor: Actor, id: string): SessionDeletionImpactDto {
      return { hasLinkedCodexThread: Boolean(requireSessionForActor(actor, id).codex_thread_id) };
    },

    searchForActor(actor: Actor, query: string, limit = 50): SessionSearchResponseDto {
      const normalizedQuery = query.trim();
      const ownerUserId = visibleOwnerUserId(actor);
      const results = repository.searchSessionsForActor
        ? repository.searchSessionsForActor(normalizedQuery, limit, ownerUserId)
        : repository.searchSessions(normalizedQuery, limit).filter((result) => canManageOwnedResource(actor, result.session.owner_user_id));
      return SessionSearchResponseDtoSchema.parse({
        query: normalizedQuery,
        results: results.map((result) => ({
          session: presentOwnedSession(result.session),
          titleMatched: result.titleMatched,
          messageMatchCount: result.messageMatchCount,
          latestMessageMatch: result.latestMessageMatch,
        })),
      });
    },

    createForActor(actor: Actor, input: { title?: string; projectId?: string | null; engine?: EngineId | null }): SessionDto {
      const project = resolveProjectForOwner(actor, actor.userId, input.projectId);
      if (deletionState.isProjectDeleting(project.id)) throw new ServiceError(409, '项目正在删除，请稍后重试');
      const session = repository.createSession(input.title || '新对话', project.id, Boolean(input.title), input.engine ?? null, actor.userId);
      const presented = presentOwnedSession(session);
      broadcast.sessionUpdated(presented, session.owner_user_id);
      sidebarOrder.changed();
      return presented;
    },

    updateForActor(actor: Actor, id: string, updates: SessionUpdates): SessionDto {
      const current = requireOwnedSessionForActor(actor, id);
      const normalized = { ...updates };
      if (updates.project_id !== undefined) {
        normalized.project_id = resolveProjectForOwner(actor, current.owner_user_id!, updates.project_id).id;
      }
      if (!current.owner_user_id) return this.update(id, normalized);
      return audited({ actorUserId: actor.userId, action: 'session.update', resourceType: 'session', resourceId: id, ownerUserId: current.owner_user_id }, () => this.update(id, normalized));
    },

    async deleteForActor(actor: Actor, id: string): Promise<void> {
      const session = requireOwnedSessionForActor(actor, id);
      if (!session.owner_user_id) return this.delete(id);
      await auditedExternal({ actorUserId: actor.userId, action: 'session.delete', resourceType: 'session', resourceId: id, ownerUserId: session.owner_user_id }, () => this.delete(id));
    },

    list(limit = 50, offset = 0, projectId?: string): SessionDto[] {
      return repository.listSessions(limit, offset, projectId).map(presentOwnedSession);
    },

    search(query: string, limit = 50): SessionSearchResponseDto {
      const normalizedQuery = query.trim();
      return SessionSearchResponseDtoSchema.parse({
        query: normalizedQuery,
        results: repository.searchSessions(normalizedQuery, limit).map((result) => ({
          session: presentOwnedSession(result.session),
          titleMatched: result.titleMatched,
          messageMatchCount: result.messageMatchCount,
          latestMessageMatch: result.latestMessageMatch,
        })),
      });
    },

    searchMessages(id: string, query: string, limit = 500, options: SessionMessageSearchOptions = {}): SessionMessageMatchesResponseDto {
      requireSession(id);
      const normalizedQuery = query.trim();
      const result = repository.searchSessionMessages(id, normalizedQuery, limit, options);
      return SessionMessageMatchesResponseDtoSchema.parse({
        query: normalizedQuery,
        total: result.total,
        truncated: result.truncated,
        matches: result.matches,
      });
    },

    get(id: string): SessionDto | undefined {
      const session = repository.getSession(id);
      return session ? presentOwnedSession(session) : undefined;
    },

    require(id: string): SessionDto {
      return presentOwnedSession(requireSession(id));
    },

    requireDetails(id: string): SessionDetailsDto {
      return presentSessionDetails(requireSession(id));
    },

    getDeletionImpact(id: string): SessionDeletionImpactDto {
      return { hasLinkedCodexThread: Boolean(requireSession(id).codex_thread_id) };
    },

    getRecord(id: string): Session | undefined {
      return repository.getSession(id);
    },

    requireRecord(id: string): Session {
      return requireSession(id);
    },

    create(input: { title?: string; projectId?: string | null; engine?: EngineId | null }): SessionDto {
      const projectId = resolveProjectId(input.projectId);
      if (deletionState.isProjectDeleting(projectId)) throw new ServiceError(409, '项目正在删除，请稍后重试');
      const session = presentOwnedSession(repository.createSession(input.title || '新对话', projectId, Boolean(input.title), input.engine ?? null));
      broadcast.sessionUpdated(session);
      sidebarOrder.changed();
      return session;
    },

    bindEngine(id: string, engine: EngineId): { session: Session; newlyBound: boolean } {
      requireSession(id);
      if (!repository.bindSessionEngine) throw new ServiceError(500, '会话引擎绑定能力不可用');
      const result = repository.bindSessionEngine(id, engine);
      broadcast.sessionUpdated(presentOwnedSession(result.session), result.session.owner_user_id);
      return result;
    },

    rollbackEngineBinding(id: string, engine: EngineId): void {
      repository.unbindSessionEngine?.(id, engine);
      const session = repository.getSession(id);
      if (session) broadcast.sessionUpdated(presentOwnedSession(session), session.owner_user_id);
    },

    update(id: string, updates: SessionUpdates): SessionDto {
      const current = requireSession(id);
      const deletionBlock = deletionState.getSessionBlock(id, current.project_id);
      if (deletionBlock) throw new ServiceError(409, deletionBlock.message);
      const normalizedUpdates: SessionPersistenceUpdates = { ...updates };
      if (updates.project_id !== undefined) {
        normalizedUpdates.project_id = resolveProjectId(updates.project_id);
        if (deletionState.isProjectDeleting(normalizedUpdates.project_id)) {
          throw new ServiceError(409, '项目正在删除，请稍后重试');
        }
      }
      if (updates.title !== undefined) normalizedUpdates.title_manually_set = 1;
      repository.updateSession(id, normalizedUpdates);
      const session = presentOwnedSession(requireSession(id));
      broadcast.sessionUpdated(session);
      if (updates.pinned !== undefined || updates.project_id !== undefined || updates.archived !== undefined) sidebarOrder.changed();
      return session;
    },

    updateEnginePreferences(
      id: string,
      input: { modelId: string | null; reasoningEffort: string | null; serviceTier?: string | null; expectedRevision: number },
    ): SessionDto {
      requireSession(id);
      if (!repository.updateEnginePreferences) {
        throw new ServiceError(500, '会话模型偏好能力不可用');
      }
      const updated = repository.updateEnginePreferences(id, input);
      if (!updated) {
        const current = repository.getSession(id);
        if (!current) throw new ServiceError(404, '会话不存在');
        if (isEnginePreferencesLockedStatus(current.status)) {
          throw new ServiceError(409, '会话正在运行，暂时不能切换模型', 'SESSION_ENGINE_PREFERENCES_LOCKED');
        }
        throw new ServiceError(409, '会话模型偏好已在其他设备更新', 'SESSION_ENGINE_PREFERENCES_CONFLICT');
      }
      const session = presentOwnedSession(updated);
      broadcast.sessionUpdated(session);
      return session;
    },

    updateEnginePreferencesForActor(
      actor: Actor,
      id: string,
      input: { modelId: string | null; reasoningEffort: string | null; serviceTier?: string | null; expectedRevision: number },
    ): SessionDto {
      const current = requireOwnedSessionForActor(actor, id);
      if (!current.owner_user_id) return this.updateEnginePreferences(id, input);
      return audited({
        actorUserId: actor.userId, action: 'session.engine_preferences_update', resourceType: 'session',
        resourceId: id, ownerUserId: current.owner_user_id,
      }, () => this.updateEnginePreferences(id, input));
    },

    updateRuntimeStatus(id: string, status: SessionStatus): SessionDto {
      requireSession(id);
      repository.updateSession(id, { status });
      const session = presentOwnedSession(requireSession(id));
      broadcast.sessionUpdated(session);
      return session;
    },

    incrementContextCompactionCount(id: string, event: { threadId: string; turnId: string }): SessionDto {
      requireSession(id);
      if (!repository.incrementSessionContextCompactionCount) {
        throw new ServiceError(500, '会话上下文整理计数能力不可用');
      }
      const result = repository.incrementSessionContextCompactionCount(id, event);
      const session = presentOwnedSession(requireSession(id));
      if (result.incremented) broadcast.sessionUpdated(session);
      return session;
    },

    updateAutomaticTitle(id: string, title: string): SessionDto | undefined {
      const current = requireSession(id);
      if (current.title_manually_set || current.title === title) return undefined;
      repository.updateSession(id, { title, title_manually_set: 0 });
      const session = presentOwnedSession(requireSession(id));
      broadcast.sessionUpdated(session);
      return session;
    },

    async delete(id: string): Promise<void> {
      const session = requireSession(id);
      const reportProgress: ((stage: SessionDeletionProgressStage | null) => void) | undefined = session.owner_user_id
        ? (stage) => {
            try {
              broadcast.sessionDeletionProgress?.(id, stage, session.owner_user_id!);
            } catch (error) {
              console.error(`[SessionDelete] 广播会话 ${id} 的删除进度失败`, error);
            }
          }
        : undefined;
      try {
        await deletionState.runSessionDeletion(id, session.project_id, async () => {
          const current = requireSession(id);
          if (isSessionInProgress(current.status)) {
            throw new ServiceError(409, '会话正在处理中，完成后才能删除', 'SESSION_DELETE_IN_PROGRESS');
          }
          await deletion.prepare(current, reportProgress);
          reportProgress?.('saving');
          repository.deleteSession(id);
          if (current.owner_user_id) broadcast.sessionDeleted(id, current.owner_user_id);
          sidebarOrder.changed();
        });
      } catch (error) {
        reportProgress?.(null);
        throw error;
      }
    },

    listMessages(id: string, limit = 30, offset = 0, includeDetails = true): MessageDto[] {
      requireSession(id);
      return repository.getMessages(id, limit, offset).map((message) => presentMessage(message, { includeDetails }));
    },

    listMessagePage(
      id: string,
      limit = 30,
      cursor: MessageCursor | null = null,
      knownRevision?: number,
    ): MessagePageResultDto {
      requireSession(id);
      const revision = repository.getMessageRevision(id);
      if (!cursor && knownRevision !== undefined && knownRevision === revision) {
        return MessagePageResultDtoSchema.parse({ unchanged: true, revision });
      }
      const page = repository.getMessagePage(id, limit, cursor);
      return MessagePageResultDtoSchema.parse({
        unchanged: false,
        page: {
          sessionId: id,
          revision: page.revision,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          messages: page.messages.map((message) => presentMessageSummary(message)),
        },
      });
    },

    getMessageDetails(id: string, messageId: string): MessageDetailsDto {
      requireSession(id);
      const message = repository.getMessage(id, messageId);
      if (!message) throw new ServiceError(404, '消息不存在');
      const presented = presentMessage(message);
      return MessageDetailsDtoSchema.parse({
        sessionId: id,
        messageId,
        ...(presented.items?.length ? { items: presented.items } : {}),
        ...(presented.processContent ? { processContent: presented.processContent } : {}),
        ...(presented.processTimeline?.length ? { processTimeline: presented.processTimeline } : {}),
        ...(presented.changedFiles?.length ? { changedFiles: presented.changedFiles } : {}),
        ...(presented.changedFilesIncomplete === true ? { changedFilesIncomplete: true } : {}),
      });
    },

    getMessageRecord(id: string, messageId: string): Message | undefined {
      requireSession(id);
      return repository.getMessage(id, messageId);
    },

    hasMessages(id: string): boolean {
      return repository.getMessages(id, 1).length > 0;
    },

    saveMessage(message: NewMessage): SavedMessageRecord {
      requireSession(message.session_id);
      return repository.saveMessage(message);
    },

    saveMessages(messages: NewMessage[]): SavedMessageRecord[] {
      if (messages.length === 0) return [];
      const sessionId = messages[0]!.session_id;
      requireSession(sessionId);
      if (messages.some((message) => message.session_id !== sessionId)) {
        throw new ServiceError(400, '批量消息必须属于同一会话');
      }
      return repository.saveMessages(messages);
    },

    projectEngineTerminal(input: EngineTerminalProjectionRecord): EngineTerminalProjectionResult {
      requireSession(input.decision.sessionId);
      if (!repository.projectEngineTerminal) throw new Error('repository 不支持终态投影');
      return repository.projectEngineTerminal(input);
    },

    saveFailureMessage(input: {
      sessionId: string;
      turnId?: string | null;
      message: string;
      duration?: number | null;
    }): MessageDto {
      const saved = repository.saveMessage({
        id: uuid(),
        session_id: requireSession(input.sessionId).id,
        turn_id: input.turnId || uuid(),
        role: 'assistant',
        content: input.message,
        phase: 'error',
        items: null,
        metadata: null,
        duration: input.duration ?? null,
        stopped: 0,
      });
      return presentMessage(saved.message);
    },

    setCodexThreadId(id: string, threadId: string): void {
      requireSession(id);
      repository.setSessionCodexThreadId(id, threadId);
    },

    setEngineSessionId(id: string, externalSessionId: string): void {
      const session = requireSession(id);
      if (!session.engine) throw new Error('会话尚未绑定 AI 引擎');
      if (repository.setSessionEngineSessionId) {
        repository.setSessionEngineSessionId(id, session.engine, externalSessionId);
        return;
      }
      if (session.engine === 'codex') {
        repository.setSessionCodexThreadId(id, externalSessionId);
        return;
      }
      throw new Error(`repository 不支持保存 ${session.engine} 外部会话 ID`);
    },

    getTokenUsage(id: string): TokenUsageDto | undefined {
      const raw = requireSession(id).token_usage;
      if (!raw) return undefined;
      try {
        const parsed = TokenUsageDtoSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    },

    setTokenUsage(id: string, usage: TokenUsageDto): void {
      requireSession(id);
      repository.setSessionTokenUsage(id, usage);
    },

    setActiveTurnUsage(id: string, usage: TokenUsageDto | null): void {
      requireSession(id);
      repository.setSessionActiveTurnUsage(id, usage);
    },

    setActiveTurn(id: string, turnId: string | null, startedAt: number | null): void {
      requireSession(id);
      repository.setSessionActiveTurn?.(id, turnId, startedAt);
    },

    setActiveAttempt(id: string, attemptId: string | null): void {
      requireSession(id);
      repository.setSessionActiveAttempt?.(id, attemptId);
    },

    syncCodexArchiveStatuses(archivedThreadIds: Set<string>): SessionDto[] {
      const changed = repository.syncCodexArchivedStatuses([...archivedThreadIds]).map(presentOwnedSession);
      for (const session of changed) broadcast.sessionUpdated(session);
      return changed;
    },

    markCodexArchived(id: string, archived: boolean): SessionDto {
      requireSession(id);
      repository.setSessionCodexArchived(id, archived);
      const session = presentOwnedSession(requireSession(id));
      broadcast.sessionUpdated(session);
      return session;
    },

    async unarchiveCodex(id: string): Promise<SessionDto> {
      const session = requireSession(id);
      const deletionBlock = deletionState.getSessionBlock(id, session.project_id);
      if (deletionBlock) throw new ServiceError(409, deletionBlock.message);
      if (session.engine !== 'codex') throw new ServiceError(409, '该引擎不支持 Codex 归档操作');
      if (!session.codex_thread_id) throw new ServiceError(409, '该会话尚未关联 Codex 会话');
      try {
        await codexThreads.unarchiveThread(session.codex_thread_id);
      } catch (error) {
        throw new ServiceError(502, `取消 Codex 归档失败：${error instanceof Error ? error.message : '未知错误'}`);
      }
      runtime.closeSessionConnection(id);
      repository.setSessionCodexArchived(id, false);
      repository.updateSession(id, { status: 'idle' });
      const updated = presentOwnedSession(requireSession(id));
      broadcast.sessionUpdated(updated);
      return updated;
    },

    async unarchiveCodexForActor(actor: Actor, id: string): Promise<SessionDto> {
      const current = requireOwnedSessionForActor(actor, id);
      if (!current.owner_user_id) return this.unarchiveCodex(id);
      return auditedExternal({
        actorUserId: actor.userId, action: 'session.unarchive', resourceType: 'session',
        resourceId: id, ownerUserId: current.owner_user_id,
      }, () => this.unarchiveCodex(id));
    },
  };
}

export const sessionService = createSessionService();
