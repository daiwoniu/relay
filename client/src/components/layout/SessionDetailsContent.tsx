import type { Project, Session } from '../../stores/chat';
import { engineLabel } from '../../engine/catalog';
import { getSessionStatusPresentation, getSessionDisplayStage, type DisplayedSessionStatus } from './session-status';
import { useAuth } from '../../auth/AuthContext';

export default function SessionDetailsContent({ session, project, status, engineSessionLoadFailed = false }: {
  session: Session & { engine_session_id?: string | null };
  project: Project | null;
  status: DisplayedSessionStatus;
  engineSessionLoadFailed?: boolean;
}) {
  const { user } = useAuth();
  const presentation = getSessionStatusPresentation(status, session.pending_action_kind, session.owner?.id === user?.id, getSessionDisplayStage(session));
  const engineSessionId = engineSessionLoadFailed
    ? '读取失败'
    : session.engine_session_id === undefined
      ? '正在读取…'
      : session.engine_session_id ?? '尚未绑定';
  const messageCount = session.message_count === undefined ? '—' : `${session.message_count} 条`;
  return (
    <div className="space-y-1.5 text-xs">
      <div className="truncate font-medium text-[var(--color-text)]">{session.title}</div>
      <div className="select-all break-all text-[11px] text-[var(--color-text-secondary)]">ID：{session.id}</div>
      <div className="text-[var(--color-text-secondary)]">项目：{project?.name ?? '默认项目'}</div>
      <div className="text-[var(--color-text-secondary)]">创建人：{session.owner ? `${session.owner.displayName} (@${session.owner.username})` : '未知'}</div>
      <div className="text-[var(--color-text-secondary)]">引擎：{session.engine ? engineLabel(session.engine) : '尚未选择'}</div>
      <div className="text-[var(--color-text-secondary)]">消息数量：{messageCount}</div>
      <div className="break-all text-[11px] text-[var(--color-text-secondary)]">
        引擎会话 ID：<span className={session.engine_session_id ? 'select-all' : undefined}>{engineSessionId}</span>
      </div>
      <div className="text-[var(--color-text-secondary)]">状态：{presentation.label}</div>
      {session.last_result && <div className="text-[var(--color-text-secondary)]">最近结果：{getSessionStatusPresentation(session.last_result.status, null, true, session.last_result.executionStage).label}</div>}
      {session.codex_archived && <div className="text-[var(--color-text-secondary)]">归档：已归档</div>}
    </div>
  );
}
