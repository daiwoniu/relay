import type { Project, Session } from '../../stores/chat';
import {useFeatureView} from '../../analytics/features';
import { engineLabel } from '../../engine/catalog';
import { getSessionStatusPresentation, getSessionDisplayStage, type DisplayedSessionStatus } from './session-status';
import { useAuth } from '../../auth/AuthContext';
import { formatResourcePerson } from '../../utils/resource-person';
import FeishuSessionAssociation from '../feishu-im/FeishuSessionAssociation';

export default function SessionDetailsContent({ session, project, status, engineSessionLoadFailed = false }: {
  session: Session & { engine_session_id?: string | null };
  project: Project | null;
  status: DisplayedSessionStatus;
  engineSessionLoadFailed?: boolean;
}) {
  const { user } = useAuth();
  useFeatureView('session',true,'header','details');
  const presentation = getSessionStatusPresentation(status, session.pending_action_kind, session.owner?.id === user?.id, getSessionDisplayStage(session));
  const engineSessionId = engineSessionLoadFailed
    ? '读取失败'
    : session.engine_session_id === undefined
      ? '正在读取…'
      : session.engine_session_id ?? '尚未绑定';
  const messageCount = session.message_count === undefined ? '—' : `${session.message_count} 条`;
  const assistantMessageCount = session.assistant_message_count === undefined ? '—' : `${session.assistant_message_count} 条`;
  const lastResultLabel = session.last_result ? getSessionStatusPresentation(session.last_result.status, null, true, session.last_result.executionStage).label : null;
  return (
    <div className="space-y-1.5 text-xs">
      <div className="break-words font-medium text-[var(--color-text)]">{session.title}</div>
      {user?.role === 'admin' && <FeishuSessionAssociation sessionId={session.id} />}
      <div className="break-words text-[var(--color-text-secondary)]">项目：{project?.name ?? '未知项目'}</div>
      <div className="break-words text-[var(--color-text-secondary)]">创建人：{formatResourcePerson(session.owner)}</div>
      <div className="break-words text-[var(--color-text-secondary)]">引擎：{session.engine ? engineLabel(session.engine) : '尚未选择'} · 消息数量：{messageCount} · 助手：{assistantMessageCount}</div>
      <div className="text-[var(--color-text-secondary)]">状态：{presentation.label}</div>
      {lastResultLabel && lastResultLabel !== presentation.label && <div className="text-[var(--color-text-secondary)]">最近结果：{lastResultLabel}</div>}
      {session.codex_archived && <div className="text-[var(--color-text-secondary)]">归档：已归档</div>}
      <div className="border-t border-[var(--color-border-light)] pt-1.5 text-[11px] text-[var(--color-text-tertiary)]">
        <div className="select-all break-all">会话 ID：{session.id}</div>
        <div className="mt-1 break-all">引擎会话 ID：<span className={session.engine_session_id ? 'select-all' : undefined}>{engineSessionId}</span></div>
      </div>
    </div>
  );
}
