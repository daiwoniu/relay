import { useEffect, useRef, useState, type FormEvent } from 'react';
import { changePassword, changeUsername, removeAvatar, setDefaultEngine, setDefaultModel, setDefaultProject, updateProfile, uploadAvatar } from '../../api/auth';
import type { EngineId } from '../../generated/relay-contracts';
import { useAuth } from '../../auth/AuthContext';
import { calculateAvatarCrop, validateNewPassword } from './avatar-editor';
import UserAvatar from './UserAvatar';
import IconActionButton from '../ui/IconActionButton';
import PanelShell from '../ui/PanelShell';
import SettingsNavigation from '../ui/SettingsNavigation';
import { useChatStore } from '../../stores/chat';
import ThemeSettingsDialog, { type ThemeSettingsDialogHandle } from '../theme/ThemeSettingsDialog';
import NotificationSettingsDialog from '../settings/NotificationSettingsDialog';
import PreviewSettings from '../settings/PreviewSettings';
import ConfirmDialog from '../ui/ConfirmDialog';
import { FormField, FormFeedback, formControlClassName, primaryFormButtonClassName, secondaryFormButtonClassName } from '../ui/FormControls';
import SessionEngineBadge from '../chat/SessionEngineBadge';
import { ENGINE_PRESENTATION_LIST } from '../../engine/catalog';
import { useEngineStatuses } from '../chat/use-engine-statuses';
import { useEngineModelsStore } from '../../stores/engine-models';
import { buildModelChoices } from '../chat/model-settings-presentation';
import { filterSelectableProjects } from '../layout/session-project';

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((webp) => {
      if (webp) { resolve(webp); return; }
      canvas.toBlob((jpeg) => jpeg ? resolve(jpeg) : reject(new Error('当前浏览器无法处理头像')), 'image/jpeg', 0.88);
    }, 'image/webp', 0.88);
  });
}

type AccountSectionId = 'profile' | 'security' | 'project' | 'appearance' | 'notifications' | 'preview';

const ACCOUNT_SECTIONS: Array<{ id: AccountSectionId; label: string; description: string; adminOnly?: boolean }> = [
  { id: 'profile', label: '个人资料', description: '头像、昵称与账号身份' },
  { id: 'security', label: '登录与安全', description: '登录名与密码' },
  { id: 'project', label: '新对话', description: '默认设置' },
  { id: 'appearance', label: '外观', description: '主题、背景与面板效果' },
  { id: 'notifications', label: '通知', description: '系统通知与提示音' },
  { id: 'preview', label: '文件预览', description: '预览容量与图片清晰度，仅对本人账号生效' },
];

function SectionIcon({ section }: { section: AccountSectionId }) {
  if (section === 'preview') return <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>;
  const path = section === 'profile'
    ? <><circle cx="12" cy="8" r="3" /><path d="M5.5 19c.8-3.2 3-4.8 6.5-4.8s5.7 1.6 6.5 4.8" /></>
    : section === 'security'
      ? <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2" /></>
      : section === 'project'
        ? <><path d="M4 7.5h6l1.7 2H20v8.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" /><path d="M4 8V6a2 2 0 0 1 2-2h4l1.5 2H18a2 2 0 0 1 2 2v1.5" /></>
      : section === 'appearance'
            ? <><path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5c0-1-1-1.6-1.8-1l-1 .7a2 2 0 0 1-2.8-2.7l.7-1.1c.6-.9 0-1.9-1-2.1A9 9 0 0 0 12 3.5Z"/><circle cx="8" cy="8" r=".8" fill="currentColor" stroke="none"/><circle cx="6.5" cy="12" r=".8" fill="currentColor" stroke="none"/></>
            : <><path d="M12 4.5a4 4 0 0 0-4 4v2c0 1-.4 2-1 2.8L5.5 15h13L17 13.3a4.5 4.5 0 0 1-1-2.8v-2a4 4 0 0 0-4-4Z"/><path d="M10 18h4"/></>;
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{path}</svg>;
}

function DefaultEnginePicker({ value, pending, onChange }: { value: EngineId; pending: boolean; onChange: (engine: EngineId) => void }) {
  const { engineStatuses, engineStatusState } = useEngineStatuses();
  return <div role="radiogroup" aria-label="默认引擎" className="default-engine-grid">
    {ENGINE_PRESENTATION_LIST.map(({ id, label, vendor }) => {
      const selected = value === id;
      const status = engineStatuses.find((candidate) => candidate.id === id);
      const statusLabel = engineStatusState === 'loading' ? '检测中…'
        : engineStatusState === 'error' ? '状态未知'
          : status?.available ? '可用' : status?.message || '不可用';
      return <button key={id} type="button" role="radio" aria-checked={selected} data-selected={selected} disabled={pending} onClick={() => onChange(id)} className="default-engine-option">
        <SessionEngineBadge engine={id} size="panel" />
        <span className="default-engine-copy"><span className="default-engine-title">{label}</span><span className="default-engine-status">{vendor} · {statusLabel}</span></span>
      </button>;
    })}
  </div>;
}

export default function AccountSettingsDialog({ open, onClose, mobile }: { open: boolean; onClose: () => void; mobile: boolean }) {
  const { user, updateUser, finishPasswordChange } = useAuth();
  const projects = useChatStore((state) => state.projects);
  const [activeSection, setActiveSection] = useState<AccountSectionId>('profile');
  const wasOpenRef = useRef(false);
  const [displayName, setDisplayName] = useState('');
  const [profilePending, setProfilePending] = useState(false);
  const [profileMessage, setProfileMessage] = useState('');
  const [profileError, setProfileError] = useState('');
  const [avatarSource, setAvatarSource] = useState<string | null>(null);
  const [sourceSize, setSourceSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [avatarPending, setAvatarPending] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [username, setUsername] = useState('');
  const [usernamePassword, setUsernamePassword] = useState('');
  const [usernamePending, setUsernamePending] = useState(false);
  const [usernameMessage, setUsernameMessage] = useState('');
  const [usernameError, setUsernameError] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordPending, setPasswordPending] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [defaultPending, setDefaultPending] = useState(false);
  const [defaultError, setDefaultError] = useState('');
  const defaultModelCatalog = useEngineModelsStore((state) => user ? state.byEngine[user.defaultEngine] : undefined);
  const loadModels = useEngineModelsStore((state) => state.load);
  const defaultModelChoices = buildModelChoices(defaultModelCatalog?.catalog?.models ?? []);
  const defaultModelCatalogUnavailable = !defaultModelCatalog?.catalog;
  const storedDefaultModelUnavailable = Boolean(user?.defaultModelId)
    && !defaultModelCatalog?.catalog?.models.some((model) => model.id === user?.defaultModelId);
  const themeSettingsRef = useRef<ThemeSettingsDialogHandle>(null);
  const [themeDirty, setThemeDirty] = useState(false);
  const [themeMinimized, setThemeMinimized] = useState(false);
  const [themeBusy, setThemeBusy] = useState(false);
  const [pendingSettingsAction, setPendingSettingsAction] = useState<'close' | AccountSectionId | null>(null);

  useEffect(() => {
    if (open && !wasOpenRef.current) setActiveSection('profile');
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open || !user) return;
    setProfileMessage(''); setProfileError(''); setUsernameMessage(''); setUsernameError(''); setPasswordError('');
    setUsernamePassword('');
    setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
    setDefaultError('');
  }, [open, user?.id]);

  useEffect(() => {
    if (!open || !user) return;
    setDisplayName(user.displayName);
    setUsername(user.username);
  }, [open, user?.id, user?.displayName, user?.username]);

  useEffect(() => {
    if (!open || !user || activeSection !== 'project') return;
    void loadModels(user.defaultEngine, { refresh: true }).catch(() => undefined);
  }, [activeSection, loadModels, open, user?.defaultEngine, user?.id]);

  useEffect(() => () => { if (avatarSource) URL.revokeObjectURL(avatarSource); }, [avatarSource]);

  useEffect(() => {
    const image = imageRef.current;
    const canvas = canvasRef.current;
    if (!image || !canvas || !sourceSize.width || !sourceSize.height) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const crop = calculateAvatarCrop(sourceSize.width, sourceSize.height, zoom, offsetX, offsetY);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, crop.sx, crop.sy, crop.size, crop.size, 0, 0, canvas.width, canvas.height);
  }, [avatarSource, offsetX, offsetY, sourceSize, zoom]);

  if (!user) return null;

  const chooseAvatar = (file: File | undefined) => {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setProfileError('头像仅支持 JPEG、PNG 或 WebP'); return; }
    if (file.size > 10 * 1024 * 1024) { setProfileError('原始图片不能超过 10 MiB'); return; }
    setAvatarSource(URL.createObjectURL(file));
    setSourceSize({ width: 0, height: 0 });
    setZoom(1); setOffsetX(0); setOffsetY(0); setProfileError(''); setProfileMessage('');
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault(); setProfilePending(true); setProfileError(''); setProfileMessage('');
    try { const response = await updateProfile(displayName.trim()); updateUser(response.user); setDisplayName(response.user.displayName); setProfileMessage('昵称已更新'); }
    catch (cause) { setProfileError(errorMessage(cause, '昵称更新失败')); }
    finally { setProfilePending(false); }
  };

  const saveAvatar = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setAvatarPending(true); setProfileError(''); setProfileMessage('');
    try {
      const blob = await canvasToBlob(canvas);
      if (blob.size > 512 * 1024) throw new Error('处理后的头像仍然过大，请更换图片');
      const response = await uploadAvatar(blob);
      updateUser(response.user); setAvatarSource(null); setProfileMessage('头像已更新');
    } catch (cause) { setProfileError(errorMessage(cause, '头像更新失败')); }
    finally { setAvatarPending(false); }
  };

  const deleteAvatar = async () => {
    setAvatarPending(true); setProfileError(''); setProfileMessage('');
    try { const response = await removeAvatar(); updateUser(response.user); setAvatarSource(null); setProfileMessage('已恢复默认头像'); }
    catch (cause) { setProfileError(errorMessage(cause, '删除头像失败')); }
    finally { setAvatarPending(false); }
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    const validation = validateNewPassword(newPassword, confirmPassword);
    if (validation) { setPasswordError(validation); return; }
    setPasswordPending(true); setPasswordError('');
    try {
      await changePassword(currentPassword, newPassword);
      sessionStorage.setItem('relay:password-changed', '密码已更新，所有设备均已退出，请使用新密码登录。');
      finishPasswordChange();
    } catch (cause) { setPasswordError(errorMessage(cause, '密码修改失败')); }
    finally { setPasswordPending(false); }
  };

  const submitUsername = async (event: FormEvent) => {
    event.preventDefault();
    setUsernamePending(true); setUsernameError(''); setUsernameMessage('');
    try {
      const response = await changeUsername(username.trim(), usernamePassword);
      updateUser(response.user);
      setUsername(response.user.username); setUsernamePassword('');
      setUsernameMessage('登录名已更新，其他设备已退出');
    } catch (cause) { setUsernameError(errorMessage(cause, '登录名修改失败')); }
    finally { setUsernamePending(false); }
  };

  const changeConversationDefault = async (
    request: () => ReturnType<typeof setDefaultProject>,
    fallback: string,
  ) => {
    setDefaultPending(true); setDefaultError('');
    try { const response = await request(); updateUser(response.user); }
    catch (cause) { setDefaultError(errorMessage(cause, fallback)); }
    finally { setDefaultPending(false); }
  };

  const availableSections = ACCOUNT_SECTIONS;
  const selectedSection = availableSections.find((section) => section.id === activeSection) ?? availableSections[0];

  const closeSettingsNow = () => {
    setPendingSettingsAction(null);
    setThemeDirty(false);
    setThemeMinimized(false);
    onClose();
  };

  const requestSettingsClose = () => {
    if (selectedSection.id === 'appearance' && themeBusy) return;
    if (selectedSection.id === 'appearance' && themeDirty) {
      setPendingSettingsAction('close');
      return;
    }
    closeSettingsNow();
  };

  const requestSectionChange = (sectionId: AccountSectionId) => {
    if (sectionId === selectedSection.id) return false;
    if (selectedSection.id === 'appearance' && themeBusy) return false;
    if (selectedSection.id === 'appearance' && themeDirty) {
      setPendingSettingsAction(sectionId);
      return false;
    }
    setActiveSection(sectionId);
    return true;
  };

  const discardThemeAndContinue = () => {
    const action = pendingSettingsAction;
    themeSettingsRef.current?.discardChanges();
    setPendingSettingsAction(null);
    if (action === 'close') closeSettingsNow();
    else if (action) {
      setActiveSection(action);
      requestAnimationFrame(() => document.getElementById(`settings-nav-${action}`)?.focus());
    }
  };

  const navigationItems = availableSections.map((section) => ({ ...section, icon: <SectionIcon section={section.id} /> }));
  const sectionNavigation = <SettingsNavigation items={navigationItems} activeId={selectedSection.id} onChange={requestSectionChange} mobile={mobile} label="账号设置分类" panelId="account-settings-panel" />;

  return <>
    <PanelShell open={open} onClose={requestSettingsClose} closeDisabled={selectedSection.id === 'appearance' && themeBusy} closeOnEscape={!themeMinimized} suspended={themeMinimized} minimizable={selectedSection.id !== 'appearance'} title="设置中心" description={mobile ? selectedSection.description : '管理个人资料、账号安全、外观与通知'} titleId="account-settings-title" size="settings" mobile={mobile}
      headerActions={selectedSection.id === 'appearance' ? <IconActionButton label="最小化主题预览" variant="neutral" className="h-9 w-9 rounded-xl" disabled={themeBusy} onClick={() => themeSettingsRef.current?.minimize()}><svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 11.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></IconActionButton> : undefined}
      navigation={mobile ? <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55">{sectionNavigation}</div> : undefined}
      sidebar={!mobile ? <>
          <div className="mx-3 mt-3 flex items-center gap-3 rounded-xl border border-[var(--color-border-light)] bg-[var(--color-surface)] p-3">
            <UserAvatar user={user} size="lg" />
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-[var(--color-text)]">{user.displayName}</div><div className="mt-0.5 truncate text-[11px] text-[var(--color-text-tertiary)]">@{user.username}</div><span className="mt-1.5 inline-flex rounded-full bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)]">{user.role === 'admin' ? '管理员' : '成员'}</span></div>
          </div>
          <div className="min-h-0 flex-1">{sectionNavigation}</div>
          <p className="px-5 pb-4 text-[10px] leading-4 text-[var(--color-text-tertiary)]">设置会同步到当前账号的其他设备</p>
        </> : undefined}
      bodyId="account-settings-panel" bodyRole="tabpanel" bodyLabelledBy={`settings-nav-${selectedSection.id}`} bodyTabIndex={0} bodyClassName={`focus:outline-none ${(selectedSection.id === 'appearance' || selectedSection.id === 'notifications') ? 'panel-shell__body--nested-scroll' : ''} ${mobile ? 'p-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))]' : 'p-6'}`}>
          <div className={`mx-auto flex h-full min-h-0 flex-col ${selectedSection.id === 'appearance' || selectedSection.id === 'notifications' ? 'max-w-none' : 'max-w-2xl'}`}>
            {!mobile && <div className="mb-5 flex-none"><h3 className="text-lg font-semibold tracking-tight text-[var(--color-text)]">{selectedSection.label}</h3><p className="mt-1 text-xs text-[var(--color-text-secondary)]">{selectedSection.description}</p></div>}

          {selectedSection.id === 'profile' && <div className="space-y-4">
          <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="mb-4 flex items-center gap-3">
              <UserAvatar user={user} size="lg" />
              <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-[var(--color-text)]">{user.displayName}</div><div className="mt-0.5 truncate text-xs text-[var(--color-text-tertiary)]">@{user.username} · {user.role === 'admin' ? '管理员' : '成员'}</div></div>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className={secondaryFormButtonClassName}>选择头像<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => { chooseAvatar(event.target.files?.[0]); event.currentTarget.value = ''; }} /></label>
              {user.avatarUpdatedAt !== null && <button type="button" disabled={avatarPending} onClick={() => void deleteAvatar()} className={secondaryFormButtonClassName}>删除头像</button>}
            </div>
            {avatarSource && <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
              <div className="flex items-start gap-3">
                <canvas ref={canvasRef} width="256" height="256" className="h-24 w-24 shrink-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]" />
                <div className="min-w-0 flex-1 space-y-2 text-[11px] text-[var(--color-text-secondary)]">
                  <label className="block">缩放<input aria-label="头像缩放" type="range" min="1" max="3" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} className="mt-1 w-full accent-[var(--color-primary)]" /></label>
                  <label className="block">水平位置<input aria-label="头像水平位置" type="range" min="-1" max="1" step="0.02" value={offsetX} onChange={(event) => setOffsetX(Number(event.target.value))} className="mt-1 w-full accent-[var(--color-primary)]" /></label>
                  <label className="block">垂直位置<input aria-label="头像垂直位置" type="range" min="-1" max="1" step="0.02" value={offsetY} onChange={(event) => setOffsetY(Number(event.target.value))} className="mt-1 w-full accent-[var(--color-primary)]" /></label>
                </div>
              </div>
              <img ref={imageRef} src={avatarSource} alt="" className="hidden" onLoad={(event) => setSourceSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
              <div className="mt-3 flex justify-end gap-2"><button type="button" onClick={() => setAvatarSource(null)} className={secondaryFormButtonClassName}>取消</button><button type="button" disabled={!sourceSize.width || avatarPending} onClick={() => void saveAvatar()} className={primaryFormButtonClassName}>{avatarPending ? '保存中…' : '保存头像'}</button></div>
            </div>}
          </section>
          <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="mb-3"><h4 className="text-sm font-semibold text-[var(--color-text)]">公开昵称</h4><p className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">显示在账号菜单与消息来源信息中</p></div>
            <form onSubmit={saveProfile} className="space-y-3">
              <FormField label="昵称" hint="留空时使用登录用户名"><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} enterKeyHint="done" maxLength={40} className={formControlClassName} placeholder={user.username} /></FormField>
              <div className="flex items-center justify-between gap-3"><FormFeedback message={profileError || profileMessage} error={Boolean(profileError)} /><button type="submit" disabled={profilePending} className={primaryFormButtonClassName}>{profilePending ? '保存中…' : '保存资料'}</button></div>
            </form>
          </section>
          </div>}

          {selectedSection.id === 'security' && <div className="space-y-4">
          <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="mb-4"><h4 className="text-sm font-semibold text-[var(--color-text)]">登录名</h4><p className="mt-1 text-[11px] leading-4 text-[var(--color-text-tertiary)]">修改后，除当前会话外的其他设备会退出登录</p></div>
            <form onSubmit={submitUsername} className="space-y-2.5">
              <FormField label="新登录名" hint="仅支持字母、数字、点、下划线和连字符"><input required pattern="[A-Za-z0-9._-]+" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} enterKeyHint="next" maxLength={64} className={formControlClassName} /></FormField>
              <FormField label="确认当前密码"><input required type="password" autoComplete="current-password" value={usernamePassword} onChange={(event) => setUsernamePassword(event.target.value)} enterKeyHint="done" maxLength={256} className={formControlClassName} /></FormField>
              <div className="flex items-center justify-between gap-3"><FormFeedback message={usernameError || usernameMessage} error={Boolean(usernameError)} /><button type="submit" disabled={usernamePending || !username.trim() || !usernamePassword || username.trim() === user.username} className={primaryFormButtonClassName}>{usernamePending ? '修改中…' : '修改登录名'}</button></div>
            </form>
          </section>
          <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="mb-4"><h4 className="text-sm font-semibold text-[var(--color-text)]">登录密码</h4><p className="mt-1 text-[11px] leading-4 text-[var(--color-text-tertiary)]">修改后，当前账号会在所有设备退出登录</p></div>
            <form onSubmit={submitPassword} className="space-y-2.5">
              <FormField label="当前密码"><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} enterKeyHint="next" maxLength={256} className={formControlClassName} /></FormField>
              <FormField label="新密码"><input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} enterKeyHint="next" minLength={6} maxLength={50} className={formControlClassName} /></FormField>
              <FormField label="确认新密码"><input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} enterKeyHint="done" minLength={6} maxLength={50} className={formControlClassName} /></FormField>
              <FormFeedback message={passwordError} error={Boolean(passwordError)} />
              <div className="flex justify-end"><button type="submit" disabled={passwordPending || !currentPassword || !newPassword || !confirmPassword} className={primaryFormButtonClassName}>{passwordPending ? '修改中…' : '修改密码'}</button></div>
            </form>
          </section>
          </div>}

        {selectedSection.id === 'project' && <section className="conversation-defaults">
          <div><h4>新对话默认设置</h4><p>每个账号独立保存，只影响新会话，不改变已有会话</p></div>
          <div className="conversation-defaults__project"><div className="conversation-defaults__label"><div>默认项目</div><p>新对话默认创建在这里</p></div><select aria-label="个人默认项目" disabled={defaultPending} value={user.defaultProjectId ?? ''} onChange={(event) => void changeConversationDefault(() => setDefaultProject(event.target.value), '默认项目更新失败')} className={formControlClassName}>
            <option value="" disabled>请选择默认项目</option>{filterSelectableProjects(projects, user.id).map((project) => <option key={project.id} value={project.id}>{project.name}{project.access_role && project.access_role !== 'owner' && project.owner ? ` · ${project.owner.displayName}` : ''}</option>)}
          </select></div>
          <div className="conversation-defaults__engine"><div className="conversation-defaults__label"><div>默认引擎</div><p>不可用时会临时使用其他可用引擎，不会修改这里的选择</p></div><DefaultEnginePicker value={user.defaultEngine} pending={defaultPending} onChange={(engine) => void changeConversationDefault(() => setDefaultEngine(engine), '默认引擎更新失败')} /></div>
          <div className="conversation-defaults__project">
            <div className="conversation-defaults__label"><div><label htmlFor="account-default-model">默认模型</label></div><p>{defaultModelCatalog?.status === 'loading' && !defaultModelCatalog.catalog
              ? '正在加载当前引擎的模型目录…'
              : defaultModelCatalog?.error
                ? defaultModelCatalog.error
                : storedDefaultModelUnavailable && defaultModelCatalog?.catalog
                  ? '已保存的模型不在当前目录中，请重新选择'
                  : '新会话使用该模型和它的默认推理强度'}</p></div>
            <select id="account-default-model" aria-label="默认模型" disabled={defaultPending || defaultModelCatalogUnavailable} value={user.defaultModelId ?? ''} onChange={(event) => void changeConversationDefault(() => setDefaultModel(event.target.value || null), '默认模型更新失败')} className={formControlClassName}>
              {storedDefaultModelUnavailable && <option value={user.defaultModelId ?? ''} disabled>不可用 · {user.defaultModelId}</option>}
              {defaultModelChoices.map((choice) => <option key={choice.id ?? 'default'} value={choice.id ?? ''}>{choice.label}</option>)}
            </select>
          </div>
          <FormFeedback message={defaultError} error />
        </section>}

        {selectedSection.id === 'preview' && open && <PreviewSettings />}
        {selectedSection.id === 'appearance' && <div className="embedded-settings-content min-h-0 flex-1"><ThemeSettingsDialog ref={themeSettingsRef} open={open} onClose={closeSettingsNow} mobile={mobile} embedded onDirtyChange={setThemeDirty} onMinimizedChange={setThemeMinimized} onBusyChange={setThemeBusy} /></div>}
        {selectedSection.id === 'notifications' && <div className="embedded-settings-content min-h-0 flex-1"><NotificationSettingsDialog open={open} onClose={closeSettingsNow} mobile={mobile} embedded /></div>}
          </div>
    </PanelShell>
    <ConfirmDialog open={pendingSettingsAction !== null} tone="warning" title="放弃未保存的外观设置？" description="当前主题预览和未保存的背景图片将被丢弃。" cancelLabel="继续编辑" confirmLabel="放弃更改" onCancel={() => setPendingSettingsAction(null)} onConfirm={discardThemeAndContinue} />
  </>;
}
