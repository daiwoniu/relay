import type { Session } from '../../stores/chat';
import type { ContextMenuItem } from '../ui/ContextMenu';
import type { EngineCapabilitiesDto } from '../../generated/relay-contracts';
import { MenuIcon } from '../icons/MenuIcon';
import { isSessionActionInProgress } from './session-action-state';

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
