import { ServiceError } from './errors.js';

export interface DeletionState {
  isSessionDeleting(sessionId: string): boolean;
  isProjectDeleting(projectId: string): boolean;
  getSessionBlock(sessionId: string, projectId: string | null): { code: string; message: string } | null;
  runSessionDeletion(sessionId: string, projectId: string | null, operation: () => Promise<void>): Promise<void>;
  runProjectDeletion(projectId: string, sessionIds: string[], operation: () => Promise<void>): Promise<void>;
}

export function createDeletionState(): DeletionState {
  const sessionOperations = new Map<string, Promise<void>>();
  const projectOperations = new Map<string, Promise<void>>();

  return {
    isSessionDeleting: (sessionId) => sessionOperations.has(sessionId),
    isProjectDeleting: (projectId) => projectOperations.has(projectId),
    getSessionBlock(sessionId, projectId) {
      if (sessionOperations.has(sessionId)) {
        return { code: 'SESSION_DELETING', message: '会话正在删除，请稍后重试' };
      }
      if (projectId && projectOperations.has(projectId)) {
        return { code: 'PROJECT_DELETING', message: '会话所属项目正在删除，请稍后重试' };
      }
      return null;
    },

    runSessionDeletion(sessionId, projectId, operation) {
      if (projectId && projectOperations.has(projectId)) {
        throw new ServiceError(409, '项目正在删除，请稍后重试');
      }
      const existing = sessionOperations.get(sessionId);
      if (existing) return existing;

      let tracked!: Promise<void>;
      tracked = Promise.resolve().then(operation).finally(() => {
        if (sessionOperations.get(sessionId) === tracked) sessionOperations.delete(sessionId);
      });
      sessionOperations.set(sessionId, tracked);
      return tracked;
    },

    runProjectDeletion(projectId, sessionIds, operation) {
      const existing = projectOperations.get(projectId);
      if (existing) return existing;
      if (sessionIds.some((sessionId) => sessionOperations.has(sessionId))) {
        throw new ServiceError(409, '项目中有会话正在删除，请稍后重试');
      }

      let tracked!: Promise<void>;
      tracked = Promise.resolve().then(operation).finally(() => {
        if (projectOperations.get(projectId) === tracked) projectOperations.delete(projectId);
      });
      projectOperations.set(projectId, tracked);
      return tracked;
    },
  };
}

export const deletionState = createDeletionState();
