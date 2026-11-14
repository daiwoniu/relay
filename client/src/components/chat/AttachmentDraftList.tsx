import type { AttachmentDraft } from './attachment-drafts';
import { useFilePreview } from '../messages/useFilePreview';
import AttachmentThumbnail from './AttachmentThumbnail';
import { newestAttachmentsFirst } from './attachment-display-order';
import FailureNotice from '../ui/FailureNotice';

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export default function AttachmentDraftList({ attachments, disabled, onRemove, onCancel, onRetry }: {
  attachments: AttachmentDraft[];
  disabled?: boolean;
  onRemove: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const openFilePreview = useFilePreview();
  if (attachments.length === 0) return null;
  return <div className="mb-2 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="待发送附件">{newestAttachmentsFirst(attachments).map((attachment) => (
    <div key={attachment.id} className="flex min-w-[210px] max-w-[280px] flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-2">
      <button type="button" onClick={() => { if (attachment.status === 'ready') void openFilePreview(attachment.path); }} disabled={disabled || attachment.status !== 'ready'} className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-70" title={attachment.status === 'ready' ? attachment.path : attachment.name}>
        <AttachmentThumbnail attachment={attachment} />
        <span className="min-w-0"><span className="block truncate text-xs font-medium text-[var(--color-text)]">{attachment.name}</span><span className="block truncate text-[11px] text-[var(--color-text-tertiary)]">
          {attachment.kind === 'host_file' ? '主机文件' : attachment.status === 'uploading' ? `上传中 ${attachment.progress}%` : attachment.status === 'failed' ? attachment.error || '上传失败' : '设备文件'} · {formatFileSize(attachment.size)}
        </span></span>
      </button>
      {attachment.status === 'uploading' ? (
        <button type="button" onClick={() => onCancel(attachment.id)} aria-label={`取消上传 ${attachment.name}`} className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">取消</button>
      ) : attachment.status === 'failed' ? (
        <button type="button" onClick={() => onRetry(attachment.id)} aria-label={`重试上传 ${attachment.name}`} className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-[var(--color-primary)] hover:bg-[var(--color-surface-hover)]">重试</button>
      ) : null}
      <button type="button" onClick={() => onRemove(attachment.id)} disabled={disabled && attachment.status === 'ready'} aria-label={`移除附件 ${attachment.name}`} className="shrink-0 rounded-md p-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] disabled:opacity-50"><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></button>
      {attachment.status === 'failed' && <div role="alert" tabIndex={0} className="max-h-40 basis-full overflow-auto text-xs text-[var(--color-status-danger)]"><FailureNotice error={attachment.error || '上传失败'} description="附件未能完成上传。" suggestion="请检查网络和文件大小，使用附件上的重试按钮重新上传；持续失败可移除后重新选择文件。" /></div>}
    </div>
  ))}</div>;
}
