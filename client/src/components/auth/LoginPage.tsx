import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { safeNewsReturnPath } from '../news/news-page-state';
import { useTheme } from '../../hooks/useTheme';
import { useServiceStatus } from '../../hooks/useServiceStatus';
import RelayLogo from '../brand/RelayLogo';
import ToolboxIcon from '../icons/ToolboxIcon';
import { FormFeedback, FormField, formControlClassName, primaryFormButtonClassName } from '../ui/FormControls';
import ServiceStatusIndicator from '../ui/ServiceStatusIndicator';
import Tooltip from '../ui/Tooltip';
import { createLoginViewportState, updateLoginViewportState } from './login-viewport-recovery';

export default function LoginPage() {
  const { login } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { preference, effectiveTheme, cycleTheme } = useTheme();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice] = useState(() => {
    const message = sessionStorage.getItem('relay:password-changed') || '';
    sessionStorage.removeItem('relay:password-changed');
    return message;
  });
  const serviceStatus = useServiceStatus();
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    let viewportState = createLoginViewportState(viewport.width, viewport.height);
    let resetFrame = 0;
    let resetTimer: ReturnType<typeof setTimeout> | null = null;
    const resetScroll = () => {
      const apply = () => {
        shellRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      };
      cancelAnimationFrame(resetFrame);
      if (resetTimer) clearTimeout(resetTimer);
      resetFrame = requestAnimationFrame(() => {
        apply();
        resetTimer = setTimeout(apply, 80);
      });
    };
    const handleViewportResize = () => {
      const next = updateLoginViewportState(viewportState, viewport.width, viewport.height);
      viewportState = next.state;
      if (next.shouldResetScroll) resetScroll();
    };

    viewport.addEventListener('resize', handleViewportResize);
    return () => {
      viewport.removeEventListener('resize', handleViewportResize);
      cancelAnimationFrame(resetFrame);
      if (resetTimer) clearTimeout(resetTimer);
    };
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    const message = await login(username.trim(), password);
    if (message) setError(message);
    else {
      const next = new URLSearchParams(location.search).get('next');
      const destination = next === '/tools' ? next : safeNewsReturnPath(next);
      if (destination) navigate(destination, { replace: true });
    }
    setSubmitting(false);
  };

  const themeLabel = preference === 'system' ? '系统' : preference === 'dark' ? '暗色' : '浅色';

  return (
    <div ref={shellRef} className="relay-auth-shell relative flex h-full min-h-[400px] overflow-x-hidden overflow-y-auto bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="relay-auth-grid absolute inset-0" aria-hidden="true" />
      <div className="relay-auth-orb relay-auth-orb-primary" aria-hidden="true" />
      <div className="relay-auth-orb relay-auth-orb-secondary" aria-hidden="true" />

      <Tooltip content={`当前主题：${themeLabel}；点击切换`} placement="bottom" className="absolute right-4 top-4 z-10">
        <button
          type="button"
          onClick={cycleTheme}
          className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/90 px-3 py-2 text-xs text-[var(--color-text-secondary)] shadow-sm backdrop-blur transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
          aria-label={`当前主题：${themeLabel}；点击切换`}
        >
          {effectiveTheme === 'dark' ? (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M13.5 10.2A5.8 5.8 0 015.8 2.5 5.8 5.8 0 1013.5 10.2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="2.7" stroke="currentColor" strokeWidth="1.4" />
              <path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M12.6 3.4l-.9.9M4.3 11.7l-.9.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          )}
          {themeLabel}
        </button>
      </Tooltip>

      <main className="relative z-[1] m-auto w-full max-w-[420px] px-5 py-16">
        <section className="relay-auth-card overflow-hidden rounded-[28px] border border-[var(--color-border)] bg-[var(--color-surface)]/95 shadow-2xl backdrop-blur-xl">
          <div className="border-b border-[var(--color-border-light)] px-7 pb-6 pt-7 sm:px-9 sm:pt-9">
            <div className="mb-7 flex items-center gap-1">
              <RelayLogo className="h-9 w-9 text-[var(--color-brand-mark)]" />
              <div>
                <div className="flex items-center gap-2 text-lg font-semibold tracking-[-0.02em]">
                  <span>Relay</span>
                  <ServiceStatusIndicator status={serviceStatus} />
                </div>
                <div className="text-xs text-[var(--color-text-tertiary)]">连接你的工作空间</div>
              </div>
            </div>
            <h1 className="text-[26px] font-semibold tracking-[-0.035em]">欢迎回来</h1>
            <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">登录后继续访问项目、会话和多端同步内容。</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5 px-7 py-7 sm:px-9 sm:pb-9">
            {notice && <FormFeedback message={notice} className="rounded-xl border border-[var(--color-status-success)]/30 bg-[var(--color-success-hover)] px-3.5 py-2.5 leading-5" />}
            <FormField label="用户名">
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" enterKeyHint="next" autoFocus maxLength={64} className={formControlClassName} placeholder="请输入用户名" />
            </FormField>

            <FormField label="密码">
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" enterKeyHint="go" maxLength={256} className={formControlClassName} placeholder="请输入密码" />
            </FormField>

            <FormFeedback message={error} error className="min-h-5" />

            <button type="submit" disabled={submitting || !username.trim() || !password} className={`${primaryFormButtonClassName} w-full gap-2 text-sm shadow-sm`}>
              {submitting && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />}
              {submitting ? '正在登录' : '登录'}
            </button>

            <div className="space-y-1 rounded-xl border border-[var(--color-border-light)] bg-[var(--color-bg-secondary)] px-3.5 py-3 text-center text-xs leading-5 text-[var(--color-text-tertiary)]">
              <div>登录状态保持 30 天。</div>
            </div>
          </form>
          <div className="border-t border-[var(--color-border-light)] px-7 py-4 text-center text-sm sm:px-9"><Link to="/tools" className="inline-flex items-center justify-center gap-2 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"><ToolboxIcon className="shrink-0" /><span>打开工具集 · 无需登录 →</span></Link></div>
        </section>
      </main>
    </div>
  );
}
