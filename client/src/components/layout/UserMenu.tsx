import { formatDateTime } from '../../utils/date-display.ts';
import { useFeatureView,localAction,featureAction } from '../../analytics/features';
import FailureNotice from '../ui/FailureNotice';
import { useEffect, useState, type KeyboardEvent } from 'react';
import type { AuthUser } from '../../api/auth';
import { getCodexAccount } from '../../api/codex-account';
import type { CodexAccountSnapshotDto } from '../../generated/relay-contracts';
import { hasWorkspaceCodexResourceOwner, loadWorkspaceCodexAccount, readWorkspaceCodexCache, subscribeWorkspaceCodexCache } from '../workspace-console/workspace-console-cache';
import { snapshotNotice } from '../workspace-console/workspace-persistent-snapshot';
import UserAvatar from '../account/UserAvatar';
import Popover from '../ui/Popover';
import Tooltip from '../ui/Tooltip';
import { selectSidebarCodexQuota } from './sidebar-codex-quota';
import MenuGlyph from '../icons/UserMenuIcon';
import MenuDestinationIcon from './MenuDestinationIcon';

const itemClass = 'user-menu__item';

export default function UserMenu({
  user,
  anchorRect,
  mobile,
  onAnchorChange,
  onClose,
  onOpenSettings,
  onOpenShares,
  onOpenTrash,
  onOpenAdministration,
  onLogout,
}: {
  user: AuthUser | null;
  anchorRect: DOMRect | null;
  mobile: boolean;
  onAnchorChange: (rect: DOMRect | null) => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenShares: () => void;
  onOpenTrash: () => void;
  onOpenAdministration: () => void;
  onLogout: () => void;
}) {
  useFeatureView('user_menu',anchorRect!==null,mobile?'mobile_sheet':'sidebar');
  const navigateMenu = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const last = items.length - 1;
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? last
      : event.key === 'ArrowDown' ? (current + 1) % items.length
      : current < 1 ? last : current - 1;
    items[target].focus();
  };
  const run = (action: () => void) => { onClose(); action(); };
  const canReadCodexQuota = user?.role === 'admin';
  const [quotaState, setQuotaState] = useState<{ userId: string; snapshot: CodexAccountSnapshotDto | null }>(() => ({
    userId: user?.id ?? '', snapshot: canReadCodexQuota && user?.id ? readWorkspaceCodexCache(user.id).value : null,
  }));
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [warningAnchor, setWarningAnchor] = useState<DOMRect | null>(null);
  const [quotaRefreshing, setQuotaRefreshing] = useState(false);
  useEffect(() => canReadCodexQuota && user?.id ? subscribeWorkspaceCodexCache(user.id, (value) => {
    setQuotaState({ userId: user.id, snapshot: value });
    setQuotaError(value.sourceMeta?.state === 'failed_snapshot' ? value.sourceMeta.error || 'Codex 额度更新失败' : null);
  }) : undefined, [user?.id, canReadCodexQuota]);
  useEffect(() => {
    setWarningAnchor(null);
    if (!canReadCodexQuota || !user?.id) {
      setQuotaState({ userId: '', snapshot: null });
      setQuotaError(null);
      return;
    }
    let active = true;
    const cached = readWorkspaceCodexCache(user.id);
    setQuotaState({ userId: user.id, snapshot: cached.value });
    setQuotaError(null);
    void loadWorkspaceCodexAccount(user.id, () => getCodexAccount()).then(async (value) => {
      if (!active) return;
      setQuotaState({ userId: user.id, snapshot: value.status === 'ready' ? value : cached.value ?? value });
      if (value.status !== 'ready') setQuotaError(value.errorMessage || 'Codex 额度更新失败');
      if (value.sourceMeta?.state === 'snapshot' || value.sourceMeta?.state === 'failed_snapshot') {
        const refreshed = await loadWorkspaceCodexAccount(user.id, () => getCodexAccount(undefined, true), true);
        if (active) {
          setQuotaState({ userId: user.id, snapshot: refreshed.status === 'ready' ? refreshed : cached.value ?? refreshed });
          setQuotaError(refreshed.sourceMeta?.state === 'failed_snapshot' || refreshed.status !== 'ready'
            ? refreshed.sourceMeta?.error || refreshed.errorMessage || 'Codex 额度更新失败' : null);
        }
      }
    }).catch((cause) => {
      if (active) setQuotaError(cause instanceof Error ? cause.message : 'Codex 额度更新失败');
    });
    let lastAttemptAt = Date.now();
    const refreshIfDue = () => {
      if (document.visibilityState !== 'visible' || hasWorkspaceCodexResourceOwner(user.id)
        || readWorkspaceCodexCache(user.id).fresh || Date.now() - lastAttemptAt < 30 * 60_000) return;
      lastAttemptAt = Date.now();
      void loadWorkspaceCodexAccount(user.id, () => getCodexAccount(undefined, true), true).then((value) => {
        if (!active) return;
        setQuotaState((current) => current.userId === user.id
          ? { userId: user.id, snapshot: value.status === 'ready' ? value : current.snapshot ?? value }
          : current);
        setQuotaError(value.sourceMeta?.state === 'failed_snapshot' || value.status !== 'ready'
          ? value.sourceMeta?.error || value.errorMessage || 'Codex 额度更新失败' : null);
      }).catch((cause) => {
        if (active) setQuotaError(cause instanceof Error ? cause.message : 'Codex 额度更新失败');
      });
    };
    const timer = window.setInterval(refreshIfDue, 30_000);
    document.addEventListener('visibilitychange', refreshIfDue);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshIfDue); };
  }, [user?.id, canReadCodexQuota]);
  const quotaSnapshot = canReadCodexQuota && quotaState.userId === user?.id ? quotaState.snapshot : null;
  const quota = selectSidebarCodexQuota(quotaSnapshot);
  const quotaWarning = canReadCodexQuota && (quotaError !== null || quotaSnapshot?.sourceMeta?.state === 'failed_snapshot');
  const warningText = quota.length > 0
    ? snapshotNotice('Codex', quotaSnapshot?.sourceMeta)
      ?? `Codex 额度更新失败，显示上次成功读取的数据（${quotaSnapshot ? formatDateTime(quotaSnapshot.fetchedAt, { seconds: true }) : '时间未知'}）。`
    : 'Codex 额度暂时无法读取，请稍后重试。';
  const refreshQuota = async () => {
    if (!canReadCodexQuota || !user?.id || quotaRefreshing) return;
    const report=localAction('user_menu','refresh_quota','user_menu');
    setQuotaRefreshing(true);
    try {
      const next = await loadWorkspaceCodexAccount(user.id, () => getCodexAccount(undefined, true), true);
      report(next.status==='ready'&&next.sourceMeta?.state!=='failed_snapshot');
      if (next.status === 'ready') setQuotaState({ userId: user.id, snapshot: next });
      setQuotaError(next.sourceMeta?.state === 'failed_snapshot' || next.status !== 'ready'
        ? next.sourceMeta?.error || next.errorMessage || 'Codex 额度更新失败' : null);
      if (next.sourceMeta?.state === 'live') setWarningAnchor(null);
    } catch (cause) {
      report(false);
      setQuotaError(cause instanceof Error ? cause.message : 'Codex 额度更新失败');
    } finally { setQuotaRefreshing(false); }
  };

  return (
    <div className="relative min-w-0 flex-1">
      <Popover open={anchorRect !== null} anchorRect={anchorRect} onClose={onClose} placement="top" mobile={mobile} mobilePresentation={mobile ? 'sheet' : 'floating'} label="账号菜单" className={`user-menu-surface${mobile ? ' user-menu-surface--mobile' : ''}`} closeOnMouseLeave manageFocus>
        <div role="menu" className="user-menu" onKeyDown={navigateMenu}>
          <div className="user-menu__account-region">
            <button type="button" role="menuitem" onClick={() => run(onOpenSettings)} className="user-menu__account">
              {user ? <UserAvatar user={user} /> : <span className="user-menu__avatar-fallback">A</span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-[var(--color-text)]">{user?.displayName || user?.username || '账号'}</span>
                <span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-tertiary)]">设置中心</span>
              </span>
              <MenuDestinationIcon />
            </button>

          </div>

          <div className="user-menu__scroll-region">
            <button type="button" role="menuitem" onClick={() => run(onOpenShares)} className={itemClass}><span className="user-menu__item-icon"><MenuGlyph type="share" /></span><span className="min-w-0 flex-1 text-left">我的分享</span><MenuDestinationIcon /></button>
            <button type="button" role="menuitem" onClick={() => run(onOpenTrash)} className={itemClass}><span className="user-menu__item-icon"><MenuGlyph type="trash" /></span><span className="min-w-0 flex-1 text-left">回收站</span>{user?.role === 'admin' && <span className="user-menu__scope">全部账号</span>}<MenuDestinationIcon /></button>
            {user?.role === 'admin' && <button type="button" role="menuitem" onClick={() => run(onOpenAdministration)} className={itemClass}><span className="user-menu__item-icon"><MenuGlyph type="admin" /></span><span className="min-w-0 flex-1 text-left">管理中心</span><MenuDestinationIcon /></button>}
          </div>

          <div className="user-menu__section user-menu__section--session" aria-label="会话">
            <button type="button" role="menuitem" onClick={() => run(onLogout)} className={`${itemClass} user-menu__item--danger`}><span className="user-menu__item-icon"><MenuGlyph type="logout" /></span><span>退出登录</span></button>
            <div className="user-menu__version">Relay v{__RELAY_VERSION__}</div>
          </div>
        </div>
      </Popover>
      <div className="user-menu__trigger-row">
        <button type="button" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { setWarningAnchor(null); onAnchorChange(anchorRect ? null : event.currentTarget.getBoundingClientRect()); }} className="user-menu__trigger" aria-label={user ? `${user.displayName || user.username}，账号菜单` : '账号菜单'} aria-expanded={anchorRect !== null} aria-haspopup="menu">
          {user ? <UserAvatar user={user} size="sm" /> : <span className="user-menu__trigger-avatar">A</span>}
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--color-text)]">{user?.displayName || user?.username || '账号'}</span>
          {quota.length > 0 && <span className="user-menu__quota-pills" aria-label="Codex 剩余额度">
            {quota.map((item) => <Tooltip key={item.key} content={`Codex ${item.window}：剩余 ${item.remaining}%。${item.reset || '重置时间未提供'}${item.reason ? `；${item.reason}` : ''}`} asChild><span className={`user-menu__quota-pill${item.remaining <= 20 ? ' user-menu__quota-pill--low' : ''}${item.remaining === 0 ? ' user-menu__quota-pill--empty' : ''}`} role="meter" aria-label={`${item.window}剩余额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.remaining} aria-valuetext={`剩余 ${item.remaining}%`}>
              <span className="user-menu__quota-fill" style={{ width: `${item.remaining}%` }} />
              <span className="user-menu__quota-content"><span>{item.label}</span><strong>{item.remaining}%</strong></span>
            </span></Tooltip>)}
          </span>}
          <svg className={`shrink-0 transition-transform ${anchorRect ? 'rotate-180' : ''}`} width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        {quotaWarning && <Tooltip content={warningText} coexist><button type="button" className="user-menu__quota-warning" aria-label="Codex 额度更新失败，查看提醒" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => {if(!warningAnchor)featureAction('user_menu','show_quota_warning','user_menu'); onClose(); setWarningAnchor(warningAnchor ? null : event.currentTarget.getBoundingClientRect()); }}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.2 14.3 13H1.7L8 2.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="M8 6v3.4M8 11.4h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></button></Tooltip>}
      </div>
      {canReadCodexQuota && <Popover open={warningAnchor !== null} anchorRect={warningAnchor} onClose={() => setWarningAnchor(null)} placement="top" mobile={mobile} label="Codex 额度提醒" className="w-[min(280px,calc(100vw-1rem))]">
        <div className="p-3 text-xs text-[var(--color-text-secondary)]"><p>{warningText}</p>{quotaError && <p className="mt-1 text-[var(--color-text-tertiary)]"><FailureNotice error={quotaError} /></p>}<button type="button" disabled={quotaRefreshing} onClick={() => void refreshQuota()} className="mt-2 rounded-md border border-[var(--color-border)] px-2 py-1 text-[var(--color-text)] disabled:opacity-50">{quotaRefreshing ? '刷新中…' : '重新获取'}</button></div>
      </Popover>}
    </div>
  );
}
