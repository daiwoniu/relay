import { ServiceError } from './errors.js';

export interface SessionDeletionRecord {
  id: string;
  codex_thread_id: string | null;
  codex_archived: number;
  codex_archived_for_trash?: number;
}

export interface SessionDeletionRuntimePort {
  interruptSession(sessionId: string): Promise<void>;
  closeSessionConnection(sessionId: string): void;
}

export interface SessionDeletionCodexThreadPort {
  archiveThread(threadId: string): Promise<{ wasAlreadyArchived: boolean }>;
}

export interface SessionDeletionPersistencePort {
  markThreadArchived(sessionId: string, restoreOnRecovery: boolean): void;
}

export type SessionDeletionProgressStage = 'stopping' | 'archiving' | 'saving';
export type SessionDeletionProgressListener = (stage: SessionDeletionProgressStage) => void;

export function createSessionDeletionCoordinator({
  runtime,
  codexThreads,
  persistence,
}: {
  runtime: SessionDeletionRuntimePort;
  codexThreads: SessionDeletionCodexThreadPort;
  persistence: SessionDeletionPersistencePort;
}) {
  return {
    async prepare(session: SessionDeletionRecord, onProgress?: SessionDeletionProgressListener): Promise<void> {
      onProgress?.('stopping');
      try {
        await runtime.interruptSession(session.id);
      } catch (error) {
        console.error(`[SessionDelete] 停止 Codex 任务失败：${session.id}`, error);
        throw new ServiceError(502, '停止 Codex 任务失败，Relay 会话未删除');
      }

      if (session.codex_thread_id) {
        onProgress?.('archiving');
        try {
          const archived = await codexThreads.archiveThread(session.codex_thread_id);
          persistence.markThreadArchived(
            session.id,
            Boolean(session.codex_archived_for_trash) || !archived.wasAlreadyArchived,
          );
        } catch (error) {
          console.error(`[SessionDelete] 归档 Codex 会话失败：${session.id}`, error);
          throw new ServiceError(502, '归档 Codex 会话失败，Relay 会话未删除');
        }
      }

      runtime.closeSessionConnection(session.id);
    },
  };
}

export type SessionDeletionCoordinator = ReturnType<typeof createSessionDeletionCoordinator>;
