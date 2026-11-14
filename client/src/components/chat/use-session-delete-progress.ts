import { useCallback } from 'react';
import { ApiError } from '../../api/client';
import { deleteSession } from '../../api/sessions';
import { useChatStore } from '../../stores/chat';
import { useSessionDeletionProgressStore } from '../../stores/session-deletion-progress';
import { getSessionDeletePendingLabel } from './session-delete-progress';
import { isSessionActionInProgress } from './session-action-state';

interface SessionDeleteProgressOptions {
  deleteTarget: { id: string } | null;
  onClose: () => void;
  onDeleted: (sessionId: string) => void;
  onError: (message: string) => void;
}

export function useSessionDeleteProgress({ deleteTarget, onClose, onDeleted, onError }: SessionDeleteProgressOptions) {
  const sessionId = deleteTarget?.id ?? null;
  const stage = useSessionDeletionProgressStore((state) => sessionId
    ? state.bySessionId[sessionId] ?? null
    : null);
  const clearStage = useSessionDeletionProgressStore((state) => state.clearStage);
  const beginDelete = useCallback((targetSessionId: string) => clearStage(targetSessionId), [clearStage]);
  const cancelDelete = useCallback(() => {
    if (sessionId) clearStage(sessionId);
    onClose();
  }, [clearStage, onClose, sessionId]);
  const confirmDelete = useCallback(async () => {
    if (!sessionId) return;
    try {
      const latest = useChatStore.getState().sessions.find((session) => session.id === sessionId);
      if (latest && isSessionActionInProgress(latest.status)) {
        onClose();
        onError('会话正在处理中，完成后才能删除');
        return;
      }
      await deleteSession(sessionId);
      onDeleted(sessionId);
      onClose();
    } catch (error: unknown) {
      onError(error instanceof ApiError && error.status === 409
        ? '会话正在处理中，完成后才能删除'
        : error instanceof Error ? error.message : '删除会话失败');
      onClose();
    } finally {
      clearStage(sessionId);
    }
  }, [clearStage, onClose, onDeleted, onError, sessionId]);

  return {
    beginDelete,
    cancelDelete,
    confirmDelete,
    deletePendingLabel: getSessionDeletePendingLabel(stage),
  };
}
