import { v4 as uuid } from 'uuid';
import * as queries from '../db/queries.js';
import type { Message, NewMessageRecord, Project, Session, User } from '../db/queries.js';
import { forkCodexThread, ensureCodexThreadArchived } from '../codex/thread-admin.js';
import { parseMessageMetadata, serializeMessageMetadata } from '../message-metadata.js';
import { projectUploadStore } from '../uploads/project-uploads.js';
import { presentSession, type MessageAttachmentDto, type SessionDto, type UploadedFileAttachmentDto } from '../contracts/index.js';
import { isEnginePreferencesLockedStatus } from '../engine/models/preferences.js';
import { ServiceError } from './errors.js';
import { canManageOwnedResource, type Actor } from '../auth/authorization.js';
import { runAdminAuditedExternalAction } from '../db/admin-audit.js';

interface ForkRepository {
  getSession(id: string): Session | undefined;
  getProject(id: string): Project | undefined;
  getProjectByPathForOwner?(projectPath: string, ownerUserId: string): Project | undefined;
  createProject?(name: string, projectPath: string, isSystem?: boolean, ownerUserId?: string | null): Project;
  getUserById?(id: string): User | undefined;
  getAllMessages(sessionId: string): Message[];
  createForkedSession(input: {
    id: string;
    title: string;
    source: Session;
    projectId?: string;
    ownerUserId?: string | null;
    threadId: string;
    messages: NewMessageRecord[];
  }): Session;
}

interface ForkCodexPort {
  forkThread(threadId: string, lastTurnId?: string): Promise<string>;
  archiveThread(threadId: string): Promise<void>;
}

/** ZCode 等支持原生分叉的引擎:按外部会话 ID 分叉并返回新外部会话 ID。targetKind 由端口实现自行映射。 */
export interface ForkEngineSessionPort {
  forkSession(externalSessionId: string, cwd: string, target: { kind: 'latest' } | { kind: 'turn'; turnIndex: number }): Promise<{ forkedSessionId: string; targetMessageId?: string }>;
}

interface ForkUploadPort {
  copyArchivedMessage(input: {
    projectPath: string;
    sourceMessageId: string;
    targetMessageId: string;
    sourceAttachmentIds: string[];
    sourceIdentity?: { projectId: string; userId: string };
    targetIdentity?: { projectId: string; userId: string };
  }): { attachments: UploadedFileAttachmentDto[]; rollback: () => void };
}

function forkTitle(title: string): string {
  const suffix = '（新会话）';
  return `${title.slice(0, 200 - suffix.length)}${suffix}`;
}

function isCompletedAssistant(message: Message): boolean {
  if (message.role !== 'assistant' || message.stopped) return false;
  const metadata = parseMessageMetadata(message.metadata);
  return metadata.outcome === undefined || metadata.outcome === 'completed';
}

function replaceAttachments(
  source: MessageAttachmentDto[],
  uploaded: UploadedFileAttachmentDto[],
  nextId: () => string,
): MessageAttachmentDto[] {
  let uploadedIndex = 0;
  return source.map((attachment) => attachment.kind === 'uploaded_file'
    ? uploaded[uploadedIndex++]!
    : { ...attachment, id: nextId() });
}

export function createSessionForkService({
  repository = queries,
  codex = { forkThread: forkCodexThread, archiveThread: ensureCodexThreadArchived },
  engineSessions,
  uploads = projectUploadStore,
  broadcast = { sessionUpdated: () => undefined },
  sidebarOrder = { changed: () => undefined },
  diagnostic = (message: string, error: unknown) => console.warn(`[Relay] ${message}`, error),
  auditedExternal = repository === queries ? runAdminAuditedExternalAction : async (_input, action) => action(),
  id = uuid,
}: {
  repository?: ForkRepository;
  codex?: ForkCodexPort;
  /** 支持原生分叉的非 codex 引擎(如 zcode)端口,按引擎 ID 取用。 */
  engineSessions?: Partial<Record<'zcode', ForkEngineSessionPort>>;
  uploads?: ForkUploadPort;
  broadcast?: { sessionUpdated(session: SessionDto): void };
  sidebarOrder?: { changed(): void };
  diagnostic?: (message: string, error: unknown) => void;
  auditedExternal?: typeof runAdminAuditedExternalAction;
  id?: () => string;
} = {}) {
  const fork = async (
    actor: Actor | undefined,
    sourceSessionId: string,
    input: { messageId?: string },
  ): Promise<SessionDto> => {
      const source = repository.getSession(sourceSessionId);
      if (!source || source.deleted_at) throw new ServiceError(404, '来源会话不存在');
      if (actor && !canManageOwnedResource(actor, source.owner_user_id)) throw new ServiceError(404, '来源会话不存在');
      if (!source.engine || !source.engine_bound) throw new ServiceError(409, '基于现有会话创建新会话目前仅支持 Codex');
      const engineSessionPort = source.engine === 'zcode' ? engineSessions?.zcode : undefined;
      if (source.engine !== 'codex' && !engineSessionPort) {
        throw new ServiceError(409, '基于现有会话创建新会话目前仅支持 Codex');
      }
      if (source.engine === 'codex' && (!source.codex_thread_id || source.codex_archived)) {
        throw new ServiceError(409, '当前 Codex 会话无法用于创建新会话');
      }
      if (source.engine !== 'codex' && !source.engine_session_id) {
        throw new ServiceError(409, '当前会话尚未与引擎建立，无法用于创建新会话');
      }
      if (!input.messageId && isEnginePreferencesLockedStatus(source.status)) {
        throw new ServiceError(409, '会话正在运行中，完成后才能从当前会话末尾新建');
      }
      if (!source.project_id) throw new ServiceError(409, '来源会话没有有效项目');
      const project = repository.getProject(source.project_id);
      if (!project || project.deleted_at) throw new ServiceError(409, '来源项目不可用');
      let targetProject = project;
      if (actor && project.owner_user_id !== actor.userId) {
        targetProject = repository.getProjectByPathForOwner?.(project.path, actor.userId)
          ?? repository.createProject?.(project.name, project.path, false, actor.userId)
          ?? (() => { throw new ServiceError(500, '同目录项目创建能力不可用'); })();
      }

      const allMessages = repository.getAllMessages(source.id);
      if (allMessages.length === 0) throw new ServiceError(409, '来源会话没有可用于创建新会话的消息');
      let selectedMessages = allMessages;
      let lastTurnId: string | undefined;
      /** zcode turn 锚点:按 0-based 完成轮次序号(第 N 条 user 输入)取引擎 target。 */
      let zcodeTurnIndex: number | undefined;
      if (input.messageId) {
        const targetIndex = allMessages.findIndex((message) => message.id === input.messageId);
        const target = targetIndex >= 0 ? allMessages[targetIndex] : undefined;
        if (!target || !isCompletedAssistant(target) || !target.turn_id.trim()) {
          throw new ServiceError(409, '只能基于已完成的助手回复创建新会话');
        }
        selectedMessages = allMessages.slice(0, targetIndex + 1);
        lastTurnId = target.turn_id;
        if (engineSessionPort) {
          zcodeTurnIndex = allMessages.slice(0, targetIndex + 1)
            .filter((message) => message.role === 'user').length - 1;
          if (zcodeTurnIndex < 0) throw new ServiceError(409, '只能基于已完成的助手回复创建新会话');
        }
      }

      let forkedThreadId: string;
      try {
        if (engineSessionPort && source.engine_session_id) {
          // 有锚点时按第 N 轮 user 输入锚定该轮 assistant 回复;无锚点取最新状态。
          const result = await engineSessionPort.forkSession(
            source.engine_session_id,
            project.path,
            zcodeTurnIndex !== undefined ? { kind: 'turn', turnIndex: zcodeTurnIndex } : { kind: 'latest' },
          );
          forkedThreadId = result.forkedSessionId;
        } else if (source.codex_thread_id) {
          forkedThreadId = await codex.forkThread(source.codex_thread_id, lastTurnId);
        } else {
          throw new ServiceError(409, '当前 Codex 会话无法用于创建新会话');
        }
      } catch (error) {
        throw new ServiceError(502, `创建新会话失败：${error instanceof Error ? error.message : '未知错误'}`);
      }

      const rollbacks: Array<() => void> = [];
      const forkSessionId = id();
      let created: Session;
      try {
        const latest = repository.getSession(source.id);
        const latestProject = repository.getProject(source.project_id);
        const latestTargetProject = repository.getProject(targetProject.id);
        if (
          !latest
          || latest.deleted_at
          || (latest.engine === 'codex' && latest.codex_archived)
          || latest.engine !== source.engine
          || !latest.engine_bound
          || latest.engine_session_id !== source.engine_session_id
          || latest.project_id !== source.project_id
          || latest.owner_user_id !== source.owner_user_id
          || (actor && !canManageOwnedResource(actor, latest.owner_user_id))
          || !latestProject
          || latestProject.deleted_at
          || latestProject.path !== project.path
          || !latestTargetProject
          || latestTargetProject.deleted_at
          || latestTargetProject.path !== project.path
          || (actor && latestTargetProject.owner_user_id !== actor.userId)
          || (!input.messageId && isEnginePreferencesLockedStatus(latest.status))
          || (!input.messageId && latest.message_revision !== source.message_revision)
        ) {
          throw new ServiceError(409, '来源会话状态已变化，请稍后重试');
        }
        const messages = selectedMessages.map((message): NewMessageRecord => {
          const messageId = id();
          const metadata = parseMessageMetadata(message.metadata);
          let attachments = metadata.attachments;
          const uploadedAttachments = attachments?.filter(
            (attachment): attachment is UploadedFileAttachmentDto => attachment.kind === 'uploaded_file',
          ) || [];
          if (uploadedAttachments.length > 0) {
            const copied = uploads.copyArchivedMessage({
              projectPath: project.path,
              sourceMessageId: message.id,
              targetMessageId: messageId,
              sourceAttachmentIds: uploadedAttachments.map((attachment) => attachment.id),
              ...(source.owner_user_id ? { sourceIdentity: { projectId: project.id, userId: source.owner_user_id } } : {}),
              ...((actor?.userId ?? source.owner_user_id) ? { targetIdentity: { projectId: targetProject.id, userId: (actor?.userId ?? source.owner_user_id)! } } : {}),
            });
            rollbacks.push(copied.rollback);
            attachments = replaceAttachments(attachments || [], copied.attachments, id);
          } else if (attachments?.length) {
            attachments = replaceAttachments(attachments, [], id);
          }
          return {
            id: messageId,
            session_id: forkSessionId,
            turn_id: message.turn_id,
            role: message.role,
            content: message.content,
            phase: message.phase,
            items: message.items,
            metadata: serializeMessageMetadata({ ...metadata, attachments }),
            duration: message.duration,
            stopped: message.stopped,
          };
        });
        created = repository.createForkedSession({
          id: forkSessionId,
          title: forkTitle(source.title),
          source,
          projectId: targetProject.id,
          ownerUserId: actor?.userId,
          threadId: forkedThreadId,
          messages,
        });
      } catch (error) {
        for (const rollback of [...rollbacks].reverse()) {
          try { rollback(); } catch {}
        }
        // zcode 的子会话由 ZCode 自己持久化,Relay 不负责回收;codex 分叉的 thread 需归档防泄漏。
        if (!engineSessionPort) {
          try { await codex.archiveThread(forkedThreadId); } catch {}
        }
        throw error;
      }

      // 持久化成功后，通知属于尽力而为的投影，失败不能反向撤销已提交的数据。
      const presented = presentSession(
        created,
        actor ? repository.getUserById?.(actor.userId) ?? null : undefined,
      );
      try { broadcast.sessionUpdated(presented); } catch (error) {
        diagnostic('会话分支已创建，但会话状态广播失败:', error);
      }
      try { sidebarOrder.changed(); } catch (error) {
        diagnostic('会话分支已创建，但侧栏排序通知失败:', error);
      }
      return presented;
  };
  return {
    fork(sourceSessionId: string, input: { messageId?: string }): Promise<SessionDto> {
      return fork(undefined, sourceSessionId, input);
    },
    forkForActor(actor: Actor, sourceSessionId: string, input: { messageId?: string }): Promise<SessionDto> {
      const source = repository.getSession(sourceSessionId);
      if (!source?.owner_user_id || source.owner_user_id === actor.userId) {
        return fork(actor, sourceSessionId, input);
      }
      return auditedExternal({
        actorUserId: actor.userId, action: 'session.fork_from', resourceType: 'session',
        resourceId: sourceSessionId, ownerUserId: source.owner_user_id,
      }, () => fork(actor, sourceSessionId, input));
    },
  };
}

export const sessionForkService = createSessionForkService();
