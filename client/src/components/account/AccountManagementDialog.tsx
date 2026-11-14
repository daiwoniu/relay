import FailureNotice from '../ui/FailureNotice';
import { useEffect, useState, type FormEvent } from 'react';
import type { PublicUserDto } from '../../generated/relay-contracts';
import { createMember, listUsers, resetUserPassword, setUserCanCreateProject, setUserDisabled } from '../../api/auth';
import { useAuth } from '../../auth/AuthContext';
import { validateNewPassword } from './avatar-editor';
import UserAvatar from './UserAvatar';
import ConfirmDialog from '../ui/ConfirmDialog';
import { FormField, FormFeedback, formControlClassName, primaryFormButtonClassName, secondaryFormButtonClassName } from '../ui/FormControls';
import PanelShell from '../ui/PanelShell';
import { useChatStore } from '../../stores/chat';

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export default function AccountManagementDialog({ open, onClose, mobile }: { open: boolean; onClose: () => void; mobile: boolean }) {
  const { user } = useAuth();
  const [users, setUsers] = useState<PublicUserDto[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState('');
  const [disableTarget, setDisableTarget] = useState<PublicUserDto | null>(null);
  const [resetTarget, setResetTarget] = useState<PublicUserDto | null>(null);
  const [adminPassword, setAdminPassword] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [resetConfirmation, setResetConfirmation] = useState('');
  const [resetPending, setResetPending] = useState(false);
  const [resetMessage, setResetMessage] = useState('');
  const [resetError, setResetError] = useState('');
  const [memberUsername, setMemberUsername] = useState('');
  const [memberDisplayName, setMemberDisplayName] = useState('');
  const [memberPassword, setMemberPassword] = useState('');
  const [createPending, setCreatePending] = useState(false);
  const [createMessage, setCreateMessage] = useState('');
  const [createError, setCreateError] = useState('');
  const [canCreateProject, setCanCreateProject] = useState(true);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const projects = useChatStore((state) => state.projects);
  const [statusPendingId, setStatusPendingId] = useState<string | null>(null);

  const clearResetCredentials = () => {
    setAdminPassword('');
    setResetPassword('');
    setResetConfirmation('');
  };

  const clearSensitiveFields = () => {
    clearResetCredentials();
    setMemberPassword('');
  };

  const cancelReset = () => {
    setResetTarget(null);
    clearResetCredentials();
    setResetError('');
  };

  const beginReset = (target: PublicUserDto) => {
    clearResetCredentials();
    setResetTarget(target);
    setResetError('');
    setResetMessage('');
  };

  const closeDialog = () => {
    clearSensitiveFields();
    setDisableTarget(null);
    setResetTarget(null);
    onClose();
  };

  const loadUsers = () => {
    setUsersLoading(true);
    setUsersError('');
    return listUsers()
      .then((response) => setUsers(response.users))
      .catch((cause) => setUsersError(errorMessage(cause, '加载账号列表失败')))
      .finally(() => setUsersLoading(false));
  };

  useEffect(() => {
    if (open) clearSensitiveFields();
    if (!open || user?.role !== 'admin') return;
    let cancelled = false;
    setUsersLoading(true); setUsersError(''); setDisableTarget(null); setResetTarget(null); setResetMessage(''); setResetError(''); setCreateMessage(''); setCreateError('');
    void listUsers()
      .then((response) => { if (!cancelled) setUsers(response.users); })
      .catch((cause) => { if (!cancelled) setUsersError(errorMessage(cause, '加载账号列表失败')); })
      .finally(() => { if (!cancelled) setUsersLoading(false); });
    return () => { cancelled = true; };
  }, [open, user?.id, user?.role]);

  if (!user || user.role !== 'admin') return null;

  const submitCreateAccount = async (event: FormEvent) => {
    event.preventDefault(); setCreatePending(true); setCreateError(''); setCreateMessage('');
    try {
      const response = await createMember({ username: memberUsername.trim(), initialPassword: memberPassword, displayName: memberDisplayName.trim() || undefined, canCreateProject, projectIds: selectedProjectIds });
      setUsers((current) => [...current, response.user]);
      setMemberUsername(''); setMemberDisplayName(''); setMemberPassword(''); setCanCreateProject(true); setSelectedProjectIds([]);
      setCreateMessage(`已创建 ${response.user.displayName}，首次登录必须修改临时密码`);
    } catch (cause) { setCreateError(errorMessage(cause, '账号创建失败')); }
    finally { setCreatePending(false); }
  };

  const updateUserDisabled = async (target: PublicUserDto, disabled: boolean) => {
    setStatusPendingId(target.id); setUsersError('');
    try {
      const response = await setUserDisabled(target.id, disabled);
      setUsers((current) => current.map((item) => item.id === target.id ? response.user : item));
    } catch (cause) { setUsersError(errorMessage(cause, '账号状态更新失败')); }
    finally { setStatusPendingId(null); }
  };

  const toggleUserDisabled = async (target: PublicUserDto) => {
    if (target.disabledAt === null) {
      setDisableTarget(target);
      return;
    }
    await updateUserDisabled(target, false);
  };

  const updateProjectPermission = async (target: PublicUserDto, allowed: boolean) => {
    setStatusPendingId(target.id); setUsersError('');
    try {
      const response = await setUserCanCreateProject(target.id, allowed);
      setUsers((current) => current.map((item) => item.id === target.id ? response.user : item));
    } catch (cause) { setUsersError(errorMessage(cause, '账号权限更新失败')); }
    finally { setStatusPendingId(null); }
  };

  const confirmDisableUser = async () => {
    if (!disableTarget) return;
    const target = disableTarget;
    await updateUserDisabled(target, true);
    setDisableTarget(null);
  };

  const submitReset = async (event: FormEvent) => {
    event.preventDefault();
    if (!resetTarget) return;
    const validation = validateNewPassword(resetPassword, resetConfirmation);
    if (validation) { setResetError(validation); return; }
    setResetPending(true); setResetError(''); setResetMessage('');
    try {
      await resetUserPassword(resetTarget.id, adminPassword, resetPassword);
      setUsers((current) => current.map((item) => item.id === resetTarget.id ? { ...item, mustChangePassword: true } : item));
      setResetMessage(`已重置 ${resetTarget.displayName} 的密码，并退出该账号的所有设备`);
      setResetTarget(null); clearResetCredentials();
    } catch (cause) { setResetError(errorMessage(cause, '密码重置失败')); }
    finally { setResetPending(false); }
  };

  const otherUsers = users.filter((item) => item.id !== user.id);

  return <PanelShell
    open={open}
    onClose={closeDialog}
    title="账号管理"
    description="创建和维护 Relay 登录账号"
    titleId="account-management-title"
    size="content"
    mobile={mobile}
    bodyClassName="space-y-4 p-4 sm:p-5"
  >
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-4 flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="text-sm font-semibold text-[var(--color-text)]">创建账号</h3><p className="mt-1 text-[11px] leading-4 text-[var(--color-text-tertiary)]">新账号首次使用临时密码登录后必须修改密码</p></div><span className="shrink-0 whitespace-nowrap rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]">管理员</span></div>
      <form onSubmit={submitCreateAccount}>
        <div className={`grid gap-2.5 ${mobile ? '' : 'grid-cols-3'}`}><FormField label="登录名"><input required pattern="[A-Za-z0-9._-]+" maxLength={64} autoComplete="off" enterKeyHint="next" value={memberUsername} onChange={(event) => setMemberUsername(event.target.value)} className={formControlClassName} /></FormField><FormField label="昵称（可选）"><input maxLength={40} autoComplete="off" enterKeyHint="next" value={memberDisplayName} onChange={(event) => setMemberDisplayName(event.target.value)} className={formControlClassName} /></FormField><FormField label="临时密码"><input required minLength={6} maxLength={50} type="password" autoComplete="new-password" enterKeyHint="done" value={memberPassword} onChange={(event) => setMemberPassword(event.target.value)} className={formControlClassName} /></FormField></div>
        <p className="mt-2 text-[11px] text-[var(--color-text-tertiary)]">账号会获得自己的 Relay 默认项目。默认项目目录可与其他账号相同，文件内容共享，但项目和会话记录彼此独立。</p>
        <div className="mt-3 grid gap-3 rounded-xl border border-[var(--color-border-light)] bg-[var(--color-bg-secondary)] p-3 sm:grid-cols-2"><label className="flex items-start gap-2 text-xs"><input className="mt-0.5" type="checkbox" checked={canCreateProject} onChange={(e) => setCanCreateProject(e.target.checked)} /><span><span className="block font-medium text-[var(--color-text)]">允许添加项目</span><span className="mt-0.5 block text-[11px] text-[var(--color-text-tertiary)]">允许选择新的工作目录</span></span></label><div><div className="text-xs font-medium text-[var(--color-text-secondary)]">初始协作项目</div><p className="mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">可多选，创建后即可直接使用这些项目</p><div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2">{projects.filter((project) => !project.is_system).length === 0 ? <div className="px-1 py-2 text-[11px] text-[var(--color-text-tertiary)]">暂无可选项目</div> : projects.filter((project) => !project.is_system).map((project) => <label key={project.id} className="flex items-start gap-2 rounded-md px-1 py-1 text-xs hover:bg-[var(--color-bg-secondary)]"><input className="mt-0.5" type="checkbox" checked={selectedProjectIds.includes(project.id)} onChange={(event) => setSelectedProjectIds((current) => event.target.checked ? [...current, project.id] : current.filter((id) => id !== project.id))} /><span className="min-w-0"><span className="block truncate font-medium text-[var(--color-text)]">{project.name}</span>{project.owner ? <span className="block truncate text-[11px] text-[var(--color-text-tertiary)]">{project.owner.displayName}</span> : null}</span></label>)}</div></div></div>
        <div className="mt-2 flex items-center justify-between gap-3"><FormFeedback message={createError || createMessage} error={Boolean(createError)} /><button disabled={createPending} className={primaryFormButtonClassName}>{createPending ? '创建中…' : '创建账号'}</button></div>
      </form>
    </section>

    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-[var(--color-text)]">登录账号</h3><p className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">停用账号或重置登录密码</p></div><button type="button" disabled={usersLoading} onClick={() => void loadUsers()} className={secondaryFormButtonClassName}>{usersLoading ? '加载中…' : '刷新'}</button></div>
      {usersError && <div role="alert" className="mb-2 rounded-lg border border-[var(--color-status-danger)]/25 bg-[var(--color-danger-hover)] px-3 py-2 text-xs text-[var(--color-status-danger)]"><FailureNotice error={usersError} /></div>}
      {usersLoading ? <div className="py-6 text-center text-xs text-[var(--color-text-secondary)]">加载账号中…</div> : otherUsers.length === 0 ? <div className="rounded-xl border border-dashed border-[var(--color-border)] px-3 py-6 text-center text-xs text-[var(--color-text-tertiary)]">当前没有其他账号</div> : <div className="space-y-2">{otherUsers.map((item) => <div key={item.id} className={`rounded-xl border px-3 py-3 ${item.disabledAt === null ? 'border-[var(--color-border-light)]' : 'border-[var(--color-status-danger)]/25 opacity-70'}`}><div className="flex items-center gap-3"><UserAvatar user={item} size="sm" /><div className="min-w-0 flex-1"><div className="truncate text-xs font-medium text-[var(--color-text)]">{item.displayName}</div><div className="truncate text-[11px] text-[var(--color-text-tertiary)]">@{item.username} · {item.role === 'admin' ? '管理员' : '成员'}{item.disabledAt !== null ? ' · 已停用' : item.mustChangePassword ? ' · 待首次改密' : ''}</div></div><div className={`flex shrink-0 gap-2 ${mobile ? 'hidden' : ''}`}><button type="button" disabled={statusPendingId === item.id} onClick={() => void toggleUserDisabled(item)} className={secondaryFormButtonClassName}>{item.disabledAt === null ? '停用' : '启用'}</button><button type="button" onClick={() => beginReset(item)} className={secondaryFormButtonClassName}>重置密码</button></div></div>{mobile && <div className="mt-3 grid grid-cols-2 gap-2"><button type="button" disabled={statusPendingId === item.id} onClick={() => void toggleUserDisabled(item)} className={secondaryFormButtonClassName}>{item.disabledAt === null ? '停用' : '启用'}</button><button type="button" onClick={() => beginReset(item)} className={secondaryFormButtonClassName}>重置密码</button></div>}{item.role !== 'admin' && <label className="mt-3 flex items-start gap-2 text-xs"><input className="mt-0.5" type="checkbox" checked={item.canCreateProject !== false} disabled={statusPendingId === item.id} onChange={(event) => void updateProjectPermission(item, event.target.checked)} /><span><span className="block font-medium text-[var(--color-text)]">允许添加项目</span><span className="mt-0.5 block text-[11px] text-[var(--color-text-tertiary)]">允许选择新的工作目录</span></span></label>}</div>)}</div>}
      {resetTarget && <form onSubmit={submitReset} className="mt-3 rounded-xl border border-[var(--color-status-warning)]/35 bg-[var(--color-notice-attention-bg)] p-3">
        <div className="mb-2 text-xs font-semibold text-[var(--color-text)]">重置 {resetTarget.displayName} 的密码</div>
        <div className={`grid gap-2.5 ${mobile ? '' : 'grid-cols-3'}`}><FormField label="管理员当前密码"><input required type="password" autoComplete="current-password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} enterKeyHint="next" maxLength={256} className={formControlClassName} /></FormField><FormField label="目标账号新密码"><input required type="password" autoComplete="new-password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} enterKeyHint="next" minLength={6} maxLength={50} className={formControlClassName} /></FormField><FormField label="确认新密码"><input required type="password" autoComplete="new-password" value={resetConfirmation} onChange={(event) => setResetConfirmation(event.target.value)} enterKeyHint="done" minLength={6} maxLength={50} className={formControlClassName} /></FormField></div>
        <FormFeedback message={resetError} error={Boolean(resetError)} className="mt-2" />
        <div className="mt-3 flex justify-end gap-2"><button type="button" onClick={cancelReset} className={secondaryFormButtonClassName}>取消</button><button type="submit" disabled={resetPending || !adminPassword || !resetPassword || !resetConfirmation} className={primaryFormButtonClassName}>{resetPending ? '重置中…' : '确认重置'}</button></div>
      </form>}
      <FormFeedback message={resetMessage} className="mt-2" />
    </section>
    <ConfirmDialog
      open={disableTarget !== null}
      title="停用账号？"
      tone="danger"
      description="停用后，该账号将无法继续登录 Relay。"
      subject={disableTarget ? {
        label: '账号',
        value: disableTarget.displayName,
        detail: `@${disableTarget.username}`,
      } : undefined}
      impacts={[
        '该账号会立即退出所有已登录设备',
        '排队中的任务会被取消',
      ]}
      notice={{ tone: 'info', title: '可以重新启用', description: '重新启用后，该账号可继续使用原登录信息。' }}
      confirmLabel="停用账号"
      onCancel={() => setDisableTarget(null)}
      onConfirm={confirmDisableUser}
    />
  </PanelShell>;
}
