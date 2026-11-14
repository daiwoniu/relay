import { useEffect, useMemo, useState } from 'react';
import { listUsers } from '../../api/auth';
import type { AuthUser } from '../../api/auth';
import type { PublicUserDto } from '../../generated/relay-contracts';
import UserAvatar from '../account/UserAvatar';
import PanelShell from '../ui/PanelShell';
import { ListSearchField, ListState } from '../ui/ListControls';

export type UserResourceSelection =
  | { type: 'mine'; user: AuthUser }
  | { type: 'user'; user: PublicUserDto }
  | { type: 'all'; user: null };

function SelectionMark({ selected }: { selected: boolean }) {
  return <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${selected ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--theme-on-primary)]' : 'border-[var(--color-border)] text-transparent'}`}>✓</span>;
}

export default function UserResourceDialog({
  open,
  onClose,
  mobile,
  currentUser,
  selectedType,
  selectedUserId,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  mobile: boolean;
  currentUser: AuthUser;
  selectedType: UserResourceSelection['type'];
  selectedUserId: string | null;
  onSelect: (selection: UserResourceSelection) => void;
}) {
  const [users, setUsers] = useState<PublicUserDto[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = () => {
    setLoading(true); setError('');
    return listUsers()
      .then((response) => setUsers(response.users))
      .catch((cause) => setError(cause instanceof Error && cause.message ? cause.message : '账号列表加载失败'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open) return;
    setQuery('');
    void load();
  }, [open]);

  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const otherUsers = useMemo(() => users
    .filter((candidate) => candidate.id !== currentUser.id)
    .filter((candidate) => !normalizedQuery
      || candidate.displayName.toLocaleLowerCase('zh-CN').includes(normalizedQuery)
      || candidate.username.toLocaleLowerCase('zh-CN').includes(normalizedQuery))
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN')),
  [currentUser.id, normalizedQuery, users]);

  const select = (selection: UserResourceSelection) => {
    onSelect(selection);
    onClose();
  };

  return <PanelShell
    open={open}
    onClose={onClose}
    title="用户资源"
    description="选择要查看的账号"
    titleId="user-resource-dialog-title"
    size="compact"
    mobile={mobile}
    bodyClassName="space-y-3 p-4"
  >
    <ListSearchField value={query} onChange={setQuery} onClear={() => setQuery('')} placeholder="搜索昵称或用户名" label="搜索账号" />

    <div className="space-y-1">
      <button type="button" onClick={() => select({ type: 'mine', user: currentUser })} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]">
        <UserAvatar user={currentUser} size="sm" />
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-[var(--color-text)]">我的资源</span><span className="block truncate text-[11px] text-[var(--color-text-tertiary)]">{currentUser.displayName} · @{currentUser.username}</span></span>
        <SelectionMark selected={selectedType === 'mine'} />
      </button>
    </div>

    <div className="border-t border-[var(--color-border-light)] pt-3">
      <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">指定账号</div>
      {loading ? <ListState kind="loading" title="正在加载账号…" compact />
        : error ? <ListState kind="error" title="账号列表加载失败" detail={error} onRetry={() => void load()} compact />
          : otherUsers.length === 0 ? <ListState kind="empty" title={normalizedQuery ? '没有匹配的账号' : '当前没有其他账号'} detail={normalizedQuery ? '换个昵称或用户名试试' : undefined} compact /> : <div className="max-h-[min(42dvh,320px)] space-y-1 overflow-y-auto">{otherUsers.map((candidate) => <button key={candidate.id} type="button" onClick={() => select({ type: 'user', user: candidate })} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]">
        <UserAvatar user={candidate} size="sm" />
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-[var(--color-text)]">{candidate.displayName}</span><span className="block truncate text-[11px] text-[var(--color-text-tertiary)]">@{candidate.username}{candidate.disabledAt !== null ? ' · 已停用' : ''}</span></span>
        <SelectionMark selected={selectedType === 'user' && selectedUserId === candidate.id} />
      </button>)}</div>}
    </div>

    <div className="border-t border-[var(--color-border-light)] pt-2">
      <button type="button" onClick={() => select({ type: 'all', user: null })} className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-sidebar-active)] text-[var(--color-text-secondary)]" aria-hidden="true"><svg viewBox="0 0 18 18" fill="none" className="h-4 w-4"><circle cx="6.5" cy="6" r="2.3" stroke="currentColor" strokeWidth="1.4"/><circle cx="12.5" cy="7" r="1.9" stroke="currentColor" strokeWidth="1.4"/><path d="M2.8 14c.5-2.8 1.8-4.1 3.9-4.1s3.4 1.3 3.9 4.1M10.5 10.6c2.7-.4 4.2.7 4.7 3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></span>
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-[var(--color-text)]">全部用户资源</span><span className="block truncate text-[11px] text-[var(--color-text-tertiary)]">跨账号查看项目和会话</span></span>
        <SelectionMark selected={selectedType === 'all'} />
      </button>
    </div>
  </PanelShell>;
}
