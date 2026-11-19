import FailureNotice from '../ui/FailureNotice';
import { useFeatureView } from '../../analytics/features';
import { useEffect, useMemo, useState } from 'react';
import type { ProjectDto, PublicUserDto } from '../../generated/relay-contracts';
import { listProjectMemberCandidates, listProjectMembers, removeProjectMember, setProjectMember, type ProjectMemberDto, type ProjectMemberRole } from '../../api/projects';
import Modal from '../ui/Modal';
import MinimizedPanelBar, { ClosePanelIcon } from '../ui/MinimizedPanelBar';
import IconActionButton from '../ui/IconActionButton';

interface Props {
  project: ProjectDto | null;
  onClose: () => void;
  onProjectUpdated?: (project: ProjectDto) => void;
}

export default function ProjectMembersDialog({ project, onClose }: Props) {
  useFeatureView('project_members',Boolean(project),'sidebar');
  const [members, setMembers] = useState<ProjectMemberDto[]>([]);
  const [users, setUsers] = useState<PublicUserDto[]>([]);
  const [selected, setSelected] = useState('');
  const [role, setRole] = useState<ProjectMemberRole>('collaborator');
  const [canViewSessions, setCanViewSessions] = useState(false);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ cause: unknown; action: string } | null>(null);
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    if (!project) { setMinimized(false); return; }
    setError(null);
    setLoading(true);
    void Promise.all([listProjectMembers(project.id), listProjectMemberCandidates(project.id)])
      .then(([projectMembers, response]) => { setMembers(projectMembers); setUsers(response.users); })
      .catch((cause) => setError({ cause, action: '加载授权信息失败' }))
      .finally(() => setLoading(false));
  }, [project]);

  const available = useMemo(
    () => users.filter((user) => !members.some((member) => member.user_id === user.id) && user.id !== project?.owner?.id),
    [members, project?.owner?.id, users],
  );

  if (!project) return null;
  const refresh = () => listProjectMembers(project.id).then(setMembers).catch((cause) => setError({ cause, action: '操作已完成，但刷新授权信息失败，请重新打开窗口核对状态' }));
  const save = async () => {
    if (!selected) return;
    setError(null);
    setPendingUserId(selected);
    try {
      await setProjectMember(project.id, selected, role, canViewSessions ? 1 : 0);
      setSelected('');
      setCanViewSessions(false);
      await refresh();
    } catch (cause) {
      setError({ cause, action: '添加授权失败' });
    } finally {
      setPendingUserId(null);
    }
  };
  const changeRole = async (userId: string, nextRole: ProjectMemberRole) => {
    const current = members.find((member) => member.user_id === userId);
    setError(null);
    setPendingUserId(userId);
    try {
      await setProjectMember(project.id, userId, nextRole, current?.can_view_sessions === 1 ? 1 : 0);
      await refresh();
    } catch (cause) {
      setError({ cause, action: '授权角色更新失败' });
    } finally {
      setPendingUserId(null);
    }
  };
  const changeViewSessions = async (userId: string, next: boolean) => {
    const current = members.find((member) => member.user_id === userId);
    if (!current) return;
    setError(null);
    setPendingUserId(userId);
    try {
      await setProjectMember(project.id, userId, current.role, next ? 1 : 0);
      await refresh();
    } catch (cause) {
      setError({ cause, action: '会话可见范围更新失败' });
    } finally {
      setPendingUserId(null);
    }
  };
  const remove = async (userId: string) => {
    setError(null);
    setPendingUserId(userId);
    try {
      await removeProjectMember(project.id, userId);
      await refresh();
    } catch (cause) {
      setError({ cause, action: '移除授权失败' });
    } finally {
      setPendingUserId(null);
    }
  };

  return <><Modal open suspended={minimized} onClose={onClose} labelledBy="project-members-title" containerClassName="items-end sm:items-center" contentClassName="w-full sm:w-auto">
    <div className="max-h-[88vh] w-full overflow-y-auto rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-xl sm:w-[min(92vw,32rem)] sm:rounded-2xl sm:p-5">
      <div className="flex items-start justify-between gap-3"><div><h2 id="project-members-title" className="text-sm font-semibold text-[var(--color-text)]">管理授权</h2><p className="mt-1 text-xs text-[var(--color-text-tertiary)]">{project.name} · 授权账号直接使用原项目</p></div><div className="flex shrink-0 items-center gap-1"><IconActionButton label="最小化管理授权" variant="neutral" tooltip={false} className="h-8 w-8" onClick={() => setMinimized(true)}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 11.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></IconActionButton><IconActionButton label="关闭管理授权" variant="neutral" tooltip={false} className="h-8 w-8" onClick={onClose}><ClosePanelIcon /></IconActionButton></div></div>
      {error && <div role="alert" className="mt-3 rounded-lg border border-[var(--color-status-danger)]/25 bg-[var(--color-danger-hover)] px-3 py-2 text-xs text-[var(--color-status-danger)]"><span className="mb-1 block font-medium">{error.action}</span><FailureNotice error={error.cause} /></div>}

      {loading ? <div className="py-8 text-center text-xs text-[var(--color-text-secondary)]">加载授权中…</div> : <>
        <section className="mt-4 space-y-2"><h3 className="text-xs font-medium text-[var(--color-text-secondary)]">已授权账号</h3>{members.length === 0 ? <div className="rounded-xl border border-dashed border-[var(--color-border)] px-3 py-5 text-center text-xs text-[var(--color-text-tertiary)]">暂未授权其他账号</div> : members.map((member) => <div key={member.user_id} className="rounded-xl border border-[var(--color-border-light)] p-3"><div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs">{users.find((user) => user.id === member.user_id)?.displayName ?? member.user_id}</span><button type="button" disabled={pendingUserId === member.user_id} className="ui-form-button ui-form-button--text text-xs text-[var(--color-danger-text)]" onClick={() => void remove(member.user_id)}>移除</button></div><select className="ui-form-control mt-2 w-full text-xs" value={member.role} disabled={pendingUserId === member.user_id} onChange={(event) => void changeRole(member.user_id, event.target.value as ProjectMemberRole)}><option value="viewer">只读：可查看项目</option><option value="collaborator">协作：可创建和使用会话</option><option value="manager">管理：可管理授权</option></select><label className="mt-2 flex items-start gap-2 text-xs"><input className="mt-0.5" type="checkbox" checked={member.can_view_sessions === 1} disabled={pendingUserId === member.user_id} onChange={(event) => void changeViewSessions(member.user_id, event.target.checked)} /><span><span className="block font-medium text-[var(--color-text)]">可查看全部会话</span><span className="mt-0.5 block text-[11px] text-[var(--color-text-tertiary)]">关闭后只能看到自己创建的会话</span></span></label></div>)}</section>
        <section className="mt-5 border-t border-[var(--color-border)] pt-4"><h3 className="text-xs font-medium text-[var(--color-text-secondary)]">添加授权</h3><div className="mt-2 grid gap-2 sm:grid-cols-[1fr_9rem_auto]"><select className="ui-form-control min-w-0 text-xs" value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">选择账号</option>{available.map((user) => <option key={user.id} value={user.id}>{user.displayName} (@{user.username})</option>)}</select><select className="ui-form-control text-xs" value={role} onChange={(event) => setRole(event.target.value as ProjectMemberRole)}><option value="viewer">只读</option><option value="collaborator">协作</option><option value="manager">管理</option></select><button type="button" disabled={!selected || pendingUserId !== null} className="ui-form-button ui-form-button--primary text-xs" onClick={() => void save()}>添加</button></div><label className="mt-2 flex items-start gap-2 text-xs"><input className="mt-0.5" type="checkbox" checked={canViewSessions} onChange={(event) => setCanViewSessions(event.target.checked)} /><span><span className="block font-medium text-[var(--color-text)]">可查看全部会话</span><span className="mt-0.5 block text-[11px] text-[var(--color-text-tertiary)]">仅对该账号生效，可稍后单独修改</span></span></label></section>
      </>}
    </div>
  </Modal><MinimizedPanelBar open={minimized} panelId={`project-members-dialog:${project.id}`} title="管理授权" description={project.name} onRestore={() => setMinimized(false)} onClose={onClose} /></>;
}
