import type { TrashRestoreResponseDto } from '../../generated/relay-contracts';

export function getTrashRestoreNotice(kind: 'project' | 'session', result: TrashRestoreResponseDto): string {
  if (result.archiveStateSyncFailedSessionCount > 0 && result.unarchiveFailedSessionCount > 0) {
    return kind === 'project'
      ? `项目已恢复，同时恢复 ${result.restoredSessionCount} 个会话；${result.unarchiveFailedSessionCount} 个 Codex 会话取消归档失败，另有 ${result.archiveStateSyncFailedSessionCount} 个已取消归档但 Relay 状态同步失败，请刷新后核对。`
      : '会话已恢复，但部分 Codex 取消归档或 Relay 状态同步失败，请刷新后核对。';
  }
  if (result.archiveStateSyncFailedSessionCount > 0) {
    return kind === 'project'
      ? `项目已恢复，同时恢复 ${result.restoredSessionCount} 个会话；其中 ${result.archiveStateSyncFailedSessionCount} 个 Codex 会话已取消归档，但 Relay 状态同步失败，请刷新后核对。`
      : '会话已恢复且 Codex 已取消归档，但 Relay 状态同步失败，请刷新后核对。';
  }
  if (result.unarchiveFailedSessionCount > 0) {
    return kind === 'project'
      ? `项目已恢复，同时恢复 ${result.restoredSessionCount} 个会话；其中 ${result.unarchiveFailedSessionCount} 个 Codex 会话取消归档失败，可进入会话后重试。`
      : '会话已恢复，但 Codex 会话取消归档失败，可进入会话后重试。';
  }
  if (result.unarchivedSessionCount > 0) {
    return kind === 'project'
      ? `项目已恢复，同时恢复 ${result.restoredSessionCount} 个会话并取消 ${result.unarchivedSessionCount} 个 Codex 归档。`
      : '会话已恢复，并已取消 Codex 归档。';
  }
  return kind === 'project'
    ? `项目已恢复，同时恢复 ${result.restoredSessionCount} 个会话。`
    : '会话已恢复。';
}

export function hasTrashRestoreWarning(result: TrashRestoreResponseDto): boolean {
  return result.unarchiveFailedSessionCount > 0 || result.archiveStateSyncFailedSessionCount > 0;
}
