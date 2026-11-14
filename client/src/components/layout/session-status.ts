import type { SessionStatus, SessionDto, ExecutionStage } from '../../generated/relay-contracts';

export type DisplayedSessionStatus = SessionStatus;

export interface SessionStatusPresentation {
  label: string;
  tone: 'none' | 'processing' | 'stopping' | 'success' | 'danger' | 'stopped' | 'interrupted' | 'warning';
}

export function getSessionStatusPresentation(status?: DisplayedSessionStatus, pendingKind?: 'approval' | 'input' | 'mixed' | null, canRespond = true, stage?: ExecutionStage | null): SessionStatusPresentation {
  switch (status) {
    case 'queued':
      return { label: '等待执行', tone: 'stopped' };
    case 'pending':
      return { label: '正在启动', tone: 'processing' };
    case 'processing':
      return { label: '处理中', tone: 'processing' };
    case 'recovering':
      return { label: '正在恢复', tone: 'processing' };
    case 'awaiting_action':
      return { label: !canRespond ? '等待会话所有人处理' : pendingKind === 'approval' ? '待授权' : pendingKind === 'input' ? '待回答' : '等待操作', tone: 'warning' };
    case 'stopping':
      return { label: stage === 'accepted' ? '正在取消' : '正在停止', tone: 'stopping' };
    case 'completed':
      return { label: '已完成', tone: 'success' };
    case 'failed':
      return { label: stage === 'accepted' ? '启动失败' : '执行失败', tone: 'danger' };
    case 'stopped':
      return { label: stage === 'accepted' ? '已取消' : '已停止', tone: 'stopped' };
    case 'interrupted':
      return { label: stage === 'accepted' ? '启动前中断' : '意外中断', tone: 'interrupted' };
    default:
      return { label: '空闲', tone: 'none' };
  }
}

export function getSessionDisplayStage(session: SessionDto): ExecutionStage | null | undefined {
  if (['completed', 'failed', 'stopped', 'interrupted'].includes(session.status)) {
    return session.status === session.last_result?.status ? session.last_result.executionStage : undefined;
  }
  return session.execution_stage;
}

export function getDisplayedSessionStatus(
  status: SessionStatus | undefined,
  _active = false,
  _codexArchived = false,
): DisplayedSessionStatus {
  return status || 'idle';
}

export function getSidebarSessionStatus(session: { status: SessionStatus; last_result?: { messageId: string } | null }, readMessageId?: string): DisplayedSessionStatus {
  const read = Boolean(session.last_result && session.last_result.messageId === readMessageId);
  return read && (session.status === 'completed' || session.status === 'stopped') ? 'idle' : session.status;
}
