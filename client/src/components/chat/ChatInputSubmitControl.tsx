import Tooltip from '../ui/Tooltip';
import type { SubmissionPhase } from './submission-state';

interface Props {
  isStreaming: boolean;
  isStopping: boolean;
  isAwaitingAction: boolean;
  isQueued: boolean;
  isCancellingQueued: boolean;
  engineSelectionRequired: boolean;
  engineUnavailable: boolean;
  submissionPhase: SubmissionPhase | 'idle';
  deletingAttachment: boolean;
  hasUnreadyAttachments: boolean;
  hasContent: boolean;
  isMobile: boolean;
  onStop: () => void;
  onCancelQueued?: () => void;
}

export default function ChatInputSubmitControl({ isStreaming, isStopping, isAwaitingAction, isQueued, isCancellingQueued, engineSelectionRequired, engineUnavailable, submissionPhase, deletingAttachment, hasUnreadyAttachments, hasContent, isMobile, onStop, onCancelQueued }: Props) {
  const isSubmitting = submissionPhase !== 'idle';
  const tooltip = engineSelectionRequired ? '请先选择 AI 引擎' : hasUnreadyAttachments ? '请等待上传完成或处理失败附件' : deletingAttachment ? '正在删除附件' : submissionPhase === 'preparing-attachments' ? '正在准备附件' : submissionPhase === 'verifying' ? '正在核实发送结果' : submissionPhase === 'sending' ? '正在发送' : hasContent ? (isMobile ? '发送消息' : '发送消息（Enter）') : '输入内容或添加附件后发送';
  const enabled = hasContent && !engineSelectionRequired && !isSubmitting && !deletingAttachment && !hasUnreadyAttachments;
  const sendControl = <Tooltip content={tooltip}>
    <button type="submit" onPointerDown={(event) => event.preventDefault()} disabled={engineUnavailable || engineSelectionRequired || isSubmitting || deletingAttachment || hasUnreadyAttachments || !hasContent} aria-label="发送消息" className={`shrink-0 rounded-xl p-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] ${enabled ? 'bg-[var(--color-primary)] text-[var(--theme-on-primary)] hover:opacity-90' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)]'}`}>
      {isSubmitting ? <span className="block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8l10-4-4 10-2-6-4-2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
    </button>
  </Tooltip>;
  if (isStreaming) {
    return (
      <div className="flex items-center gap-1 shrink-0">
        <Tooltip content={isStopping ? '正在停止' : isAwaitingAction ? '停止等待' : '停止生成'}>
          <button type="button" onClick={onStop} disabled={isStopping} className={`shrink-0 rounded-xl bg-[var(--color-danger-surface)] p-2 text-white transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] ${isStopping ? 'cursor-wait opacity-70' : 'hover:opacity-85'}`} aria-label={isStopping ? '正在停止' : isAwaitingAction ? '停止等待' : '停止生成'}>
            {isStopping ? <span className="block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1" /></svg>}
          </button>
        </Tooltip>
        {sendControl}
      </div>
    );
  }

  if (isQueued) {
    return (
      <div className="flex items-center gap-1 shrink-0">
        <Tooltip content={isCancellingQueued ? '正在取消排队' : '取消排队'}>
          <button type="button" onClick={onCancelQueued} disabled={isCancellingQueued} className="shrink-0 rounded-xl bg-[var(--color-status-warning)] p-2 text-[var(--color-bg)] transition-all hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] disabled:cursor-wait disabled:opacity-70" aria-label={isCancellingQueued ? '正在取消排队' : '取消排队'}>
            {isCancellingQueued ? <span className="block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1" /></svg>}
          </button>
        </Tooltip>
        {sendControl}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 shrink-0">
      {sendControl}
    </div>
  );
}
