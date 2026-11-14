import type { SessionDeletionProgressStage } from '../../stores/session-deletion-progress.ts';

const DELETE_PENDING_LABELS: Record<SessionDeletionProgressStage, string> = {
  stopping: '正在停止任务…',
  archiving: '正在归档 Codex 会话…',
  saving: '正在保存删除结果…',
};

export function getSessionDeletePendingLabel(stage: SessionDeletionProgressStage | null | undefined): string {
  return stage ? DELETE_PENDING_LABELS[stage] : '处理中…';
}
