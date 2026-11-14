import { useState } from 'react';
import type { SessionFollowupDto } from '../../generated/relay-contracts';
import { canCancelFollowup } from '../../stores/session-followups';
import ConfirmDialog from '../ui/ConfirmDialog';
import MessageAttachmentList from '../messages/MessageAttachmentList';

const labels: Record<SessionFollowupDto['state'], string> = {
  received: '已收到',
  steering: '正在加入当前任务',
  steered: '已加入当前任务',
  queued: '等待下一轮',
  dispatching: '正在启动下一轮',
  delivered: '已启动下一轮',
  paused: '已暂停，需手动继续',
  uncertain: '交付结果不确定，请先核对当前任务',
  cancelled: '已取消',
};

export function SessionFollowupStatus({ followups, onCancel, onResume }: {
  followups: SessionFollowupDto[];
  onCancel?: (messageId: string) => void;
  onResume?: () => void;
}) {
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const visible = followups.filter((item) => item.state !== 'steered' && item.state !== 'delivered' && item.state !== 'cancelled');
  if (visible.length === 0) return null;
  return <><div className="mx-auto w-full max-w-3xl space-y-2 px-4 pb-2" aria-label="后续消息状态">
    {visible.map((item) => <div key={item.id} className="relative rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 pr-11 text-sm">
      <MessageAttachmentList attachments={item.attachments} />
      <div className="whitespace-pre-wrap break-words text-[var(--color-text)]">{item.content || '附件消息'}</div>
      <div className="mt-1 text-xs text-[var(--color-text-secondary)]">{labels[item.state]}</div>
      {canCancelFollowup(item.state) && onCancel && <button type="button" onClick={() => {
        if (item.state === 'uncertain') { setConfirmCancelId(item.id); return; }
        onCancel(item.id);
      }} className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-lg text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-danger-hover)] hover:text-[var(--color-status-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]" aria-label={item.state === 'uncertain' ? '核对后移除此消息' : '取消并删除待发送消息'} title={item.state === 'uncertain' ? '核对后移除此消息' : '取消并删除待发送消息'}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>}
      {item.state === 'paused' && onResume && <button type="button" onClick={onResume} className="mt-1 text-xs text-[var(--color-primary)]">继续排队</button>}
    </div>)}
  </div><ConfirmDialog
    open={confirmCancelId !== null}
    title="移除待发送消息？"
    tone="warning"
    description="交付结果不确定，消息可能已经到达引擎。请先核对当前任务。"
    confirmLabel="确认移除"
    onCancel={() => setConfirmCancelId(null)}
    onConfirm={() => {
      if (confirmCancelId) onCancel?.(confirmCancelId);
      setConfirmCancelId(null);
    }}
  /></>;
}
