import Tooltip from '../ui/Tooltip';
import { featureAction } from '../../analytics/features';
import type { PublicUserDto } from '../../generated/relay-contracts';
import RelayLogo from '../brand/RelayLogo';
import UserAvatar from '../account/UserAvatar';
import ServiceStatusIndicator, { type ServiceStatus } from '../ui/ServiceStatusIndicator';
import { ListSearchField } from '../ui/ListControls';
import type { UserResourceSelection } from './UserResourceDialog';

export default function SidebarWorkbench({
  serviceStatus,
  isAdmin,
  resourceViewType,
  selectedResourceUser,
  searchQuery,
  onNewChat,
  onOpenUserResources,
  onExitUserResources,
  onSearch,
  onClearSearch,
  showAllProjectsToggle,
}: {
  serviceStatus: ServiceStatus;
  isAdmin: boolean;
  resourceViewType: UserResourceSelection['type'];
  selectedResourceUser: PublicUserDto | null;
  searchQuery: string;
  onNewChat: () => void;
  onOpenUserResources: () => void;
  onExitUserResources: () => void;
  onSearch: (query: string) => void;
  onClearSearch: () => void;
  showAllProjectsToggle: { checked: boolean; onToggle: () => void } | null;
}) {
  const searchPlaceholder = selectedResourceUser
    ? `搜索${selectedResourceUser.displayName}的会话和消息...`
    : resourceViewType === 'all' ? '搜索全部会话和消息...' : '搜索会话和消息...';

  return <div className="sidebar-workbench theme-region-section theme-sidebar-section shrink-0 p-3">
    <div className="flex items-center gap-2">
      <div className="sidebar-brand flex items-center gap-1 px-2 py-1.5">
        <RelayLogo className="h-[22px] w-[22px] text-[var(--color-brand-mark)]" />
        <span className="text-[15px] font-semibold">Relay</span>
      </div>
      <ServiceStatusIndicator status={serviceStatus} />
    </div>

    {resourceViewType === 'mine' ? <div className="flex items-center gap-1">
      <button type="button" onClick={onNewChat} className="sidebar-primary-action flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 text-sm text-[var(--color-text)] transition-colors hover:bg-[var(--color-sidebar-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 text-[var(--color-text-secondary)]" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        新对话
      </button>
      {isAdmin && <button type="button" onClick={onOpenUserResources} aria-label="切换用户资源" className="sidebar-primary-action flex shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-sidebar-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]">我的资源<span aria-hidden="true">▾</span></button>}
    </div> : <div className="sidebar-resource-view flex min-h-10 items-center gap-2 rounded-lg border border-[var(--color-primary)]/25 bg-[var(--color-sidebar-active)] px-2 py-1">
      <button type="button" onClick={onOpenUserResources} aria-label="切换用户资源" className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]">
        {selectedResourceUser ? <UserAvatar user={selectedResourceUser} size="sm" className="h-7 w-7" /> : <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface)] text-[var(--color-text-secondary)]" aria-hidden="true"><svg viewBox="0 0 18 18" fill="none" className="h-4 w-4"><circle cx="6.5" cy="6" r="2.3" stroke="currentColor" strokeWidth="1.4"/><circle cx="12.5" cy="7" r="1.9" stroke="currentColor" strokeWidth="1.4"/><path d="M2.8 14c.5-2.8 1.8-4.1 3.9-4.1s3.4 1.3 3.9 4.1M10.5 10.6c2.7-.4 4.2.7 4.7 3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></span>}
        <span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-[var(--color-text)]">{selectedResourceUser ? `${selectedResourceUser.displayName}的资源` : '全部用户资源'}</span>{selectedResourceUser && <span className="block truncate text-[10px] text-[var(--color-text-tertiary)]">@{selectedResourceUser.username}</span>}</span>
        <span aria-hidden="true" className="text-xs text-[var(--color-text-tertiary)]">▾</span>
      </button>
      {showAllProjectsToggle && <Tooltip content={showAllProjectsToggle.checked ? '当前显示全部项目，点击隐藏没有会话的空项目' : '当前隐藏没有会话的空项目，点击显示全部项目'} asChild><button type="button" onClick={showAllProjectsToggle.onToggle} aria-pressed={showAllProjectsToggle.checked} aria-label="显示全部项目" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] ${showAllProjectsToggle.checked ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-tertiary)]'}`}>
        <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" aria-hidden="true"><path d="M1.8 8s2.2-4 6.2-4 6.2 4 6.2 4-2.2 4-6.2 4-6.2-4-6.2-4Z" stroke="currentColor" strokeWidth="1.4"/><circle cx="8" cy="8" r="1.9" stroke="currentColor" strokeWidth="1.4"/>{showAllProjectsToggle.checked ? <path d="M2.5 13.5 13.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/> : <path d="M5 8h.01M8 8h.01M11 8h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>}</svg>
      </button></Tooltip>}
      <button type="button" onClick={onExitUserResources} aria-label="退出用户资源视图" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"><span aria-hidden="true">×</span></button>
    </div>}

    <ListSearchField value={searchQuery} onChange={onSearch} onClear={()=>{featureAction('session','cancel','sidebar');onClearSearch();}} onCommit={()=>featureAction('session','search','sidebar')} placeholder={searchPlaceholder} label="搜索会话和消息" compact className="sidebar-search" />
  </div>;
}
