import { useState, type FormEvent } from 'react';
import { changePassword } from '../../api/auth';
import { useAuth } from '../../auth/AuthContext';
import RelayLogo from '../brand/RelayLogo';
import { validateNewPassword } from '../account/avatar-editor';
import { FormFeedback, FormField, formControlClassName, primaryFormButtonClassName, textFormButtonClassName } from '../ui/FormControls';

export default function PasswordChangeRequired() {
  const { user, logout, finishPasswordChange } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  if (!user) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const validation = validateNewPassword(newPassword, confirmation);
    if (validation) { setError(validation); return; }
    setPending(true); setError('');
    try {
      await changePassword(currentPassword, newPassword);
      sessionStorage.setItem('relay:password-changed', '密码已更新，请使用新密码重新登录。');
      finishPasswordChange();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '密码修改失败');
    } finally { setPending(false); }
  };

  return <main className="flex min-h-full items-center justify-center bg-[var(--color-bg)] p-4 text-[var(--color-text)]">
    <section className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--color-overlay-shadow)] sm:p-6">
      <div className="flex items-center gap-2"><RelayLogo className="h-7 w-7 text-[var(--color-brand-mark)]" /><span className="text-base font-semibold">Relay</span></div>
      <h1 className="mt-5 text-lg font-semibold">首次登录，请修改密码</h1>
      <p className="mt-1 text-sm text-[var(--color-text-secondary)]">账号 @{user.username} 使用的是管理员分配的临时密码。修改后会退出当前登录，请用新密码重新进入。</p>
      <form onSubmit={submit} className="mt-5 space-y-3">
        <FormField label="当前临时密码"><input autoFocus type="password" autoComplete="current-password" enterKeyHint="next" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} maxLength={256} className={formControlClassName} /></FormField>
        <FormField label="新密码"><input type="password" autoComplete="new-password" enterKeyHint="next" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={6} maxLength={50} className={formControlClassName} /></FormField>
        <FormField label="确认新密码"><input type="password" autoComplete="new-password" enterKeyHint="done" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} minLength={6} maxLength={50} className={formControlClassName} /></FormField>
        <FormFeedback message={error} error />
        <button disabled={pending || !currentPassword || !newPassword || !confirmation} className={`${primaryFormButtonClassName} w-full text-sm`}>{pending ? '修改中…' : '修改密码并重新登录'}</button>
      </form>
      <button type="button" onClick={() => void logout()} className={`${textFormButtonClassName} mt-3 w-full`}>退出当前账号</button>
    </section>
  </main>;
}
