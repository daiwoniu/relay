import type { Session } from '../../stores/chat';
import type { ContextMenuItem } from '../ui/ContextMenu';
import type { EngineCapabilitiesDto } from '../../generated/relay-contracts';
import { isSessionActionInProgress } from './session-action-state';

export function MenuIcon({ type, pinned = false }: {
  type: 'plus' | 'pin' | 'info' | 'copy' | 'edit' | 'fork' | 'unarchive' | 'share' | 'select' | 'files' | 'trash';
  pinned?: boolean;
}) {
  const icons = {
    plus: <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>,
    pin: pinned
      ? <path d="M9.5 1.5v3.5l3 4v2.5H3.5V9l3-4V1.5h3zM7.5 11v4" fill="currentColor"/>
      : <><path d="M9.5 1.5v3.5l3 4v2.5H3.5V9l3-4V1.5h3z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/><path d="M7.5 11v3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></>,
    info: <><circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3"/><path d="M8 7v4M8 4.8v.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></>,
    copy: <><rect x="5" y="3" width="7" height="8" rx="1" stroke="currentColor" strokeWidth="1.3"/><path d="M4 5H3.5a1 1 0 00-1 1v6.5a1 1 0 001 1H9a1 1 0 001-1V12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></>,
    edit: <path d="M2 12l2-1 7-7-1-1-7 7-1 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
    fork: <><path d="M4 3v3.5A2.5 2.5 0 006.5 9H9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><path d="M9 6l3 3-3 3M4 6.5V13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></>,
    unarchive: <><path d="M3 5h10v8H3V5zM2.5 3h11v2h-11V3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M8 11V7.5M6.5 9L8 7.5 9.5 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></>,
    share: <path d="M6 4.5L8 2l2 2.5M8 2v8M3 7v6h10V7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>,
    select: <><rect x="2.5" y="2.5" width="4" height="4" rx=".7" stroke="currentColor" strokeWidth="1.2"/><rect x="9.5" y="2.5" width="4" height="4" rx=".7" stroke="currentColor" strokeWidth="1.2"/><rect x="2.5" y="9.5" width="4" height="4" rx=".7" stroke="currentColor" strokeWidth="1.2"/><path d="M10 11.5l1 1 2-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></>,
    files: <><path d="M2.5 4h4l1.4 1.5h5.6V13h-11V4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M2.5 6h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></>,
    trash: <><path d="M4 5h8l-.7 8.5a1 1 0 01-1 .5H5.7a1 1 0 01-1-.5L4 5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M3 5h10M6.5 3h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></>,
  };
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none">{icons[type]}</svg>;
}

export function createSessionMenuItems({
  session,
  capabilities,
  onPin,
  onDetails,
  onRename,
  renameLabel = '重命名',
  onCopyId,
  onFork,
  forkPending = false,
  onUnarchive,
  onSelectMessages,
  onShareSession,
  onDelete,
}: {
  session: Session;
  capabilities?: EngineCapabilitiesDto;
  onPin?: () => void;
  onDetails?: () => void;
  onRename: () => void;
  renameLabel?: string;
  onCopyId: () => void | Promise<void>;
  onFork?: () => void | Promise<void>;
  forkPending?: boolean;
  onUnarchive?: () => void | Promise<void>;
  onSelectMessages?: () => void;
  onShareSession?: () => void;
  onDelete: () => void;
}): ContextMenuItem[] {
  const actionBlockedByRunning = isSessionActionInProgress(session.status);
  return [
    ...(onPin ? [{
      id: 'pin',
      label: session.pinned ? '取消置顶' : '置顶',
      icon: <MenuIcon type="pin" pinned={!!session.pinned} />,
      onSelect: onPin,
    }] : []),
    ...(onDetails ? [{
      id: 'details',
      label: '查看详情',
      icon: <MenuIcon type="info" />,
      onSelect: onDetails,
    }] : []),
    {
      id: 'rename',
      label: renameLabel,
      icon: <MenuIcon type="edit" />,
      onSelect: onRename,
    },
    {
      id: 'copy-id',
      label: '复制会话 ID',
      icon: <MenuIcon type="copy" />,
      onSelect: onCopyId,
    },
    ...(session.can_fork && onFork ? [{
      id: 'fork',
      label: forkPending ? '正在新建会话…' : '从当前会话新建',
      icon: <MenuIcon type="fork" />,
      disabled: forkPending || actionBlockedByRunning,
      disabledReason: forkPending
        ? '正在新建会话'
        : actionBlockedByRunning ? '会话运行中，完成后才能创建新会话' : undefined,
      onSelect: onFork,
    }] : []),
    ...(onSelectMessages ? [{ id: 'share-selection', label: '选择消息分享', icon: <MenuIcon type="select" />, onSelect: onSelectMessages }] : []),
    ...(onShareSession ? [{ id: 'share-session', label: '分享整个会话', icon: <MenuIcon type="share" />, onSelect: onShareSession }] : []),
    ...(capabilities?.archive && session.codex_archived && onUnarchive ? [{
      id: 'unarchive',
      label: '取消归档',
      icon: <MenuIcon type="unarchive" />,
      onSelect: onUnarchive,
    }] : []),
    {
      id: 'delete',
      label: '删除会话',
      icon: <MenuIcon type="trash" />,
      danger: true,
      disabled: actionBlockedByRunning,
      disabledReason: actionBlockedByRunning ? '会话正在处理中，完成后才能删除' : undefined,
      onSelect: onDelete,
    },
  ];
}
