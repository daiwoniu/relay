import type { SharePreviewResponseDto } from '../../generated/relay-contracts';
import RelayLogo from '../brand/RelayLogo';
import Modal from '../ui/Modal';
import IconActionButton from '../ui/IconActionButton';
import { ClosePanelIcon } from '../ui/MinimizedPanelBar';
import PublicShareMessageList from './PublicShareMessageList';

function formatTime(value: number | null): string {
  return value === null ? '永久有效' : new Date(value).toLocaleString();
}

export default function SharePreviewDialog({ preview, onClose }: { preview: SharePreviewResponseDto | null; onClose: () => void }) {
  return (
    <Modal
      open={preview !== null}
      onClose={onClose}
      labelledBy="share-preview-title"
      contentClassName="flex max-h-[min(90vh,860px)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[var(--color-overlay-border)] bg-[var(--color-overlay-surface)] shadow-[var(--color-overlay-shadow)]"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <div><h2 id="share-preview-title" className="text-sm font-semibold text-[var(--color-text)]">分享页面预览</h2><p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">仅供当前用户查看，不会创建分享或公开链接。</p></div>
        <IconActionButton label="关闭预览" variant="neutral" tooltip={false} className="h-8 w-8" onClick={onClose}><ClosePanelIcon /></IconActionButton>
      </div>
      {preview && <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-bg)]">
        <header className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 backdrop-blur">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3"><RelayLogo className="h-8 w-8" /><div className="text-sm font-semibold text-[var(--color-text)]">Relay 分享</div></div>
            <span className="shrink-0 whitespace-nowrap rounded-full border border-[var(--color-notice-info-border)] bg-[var(--color-notice-info-bg)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)]">预览</span>
          </div>
        </header>
        <main>
          <div className="mx-auto max-w-3xl px-4 pt-6"><h1 className="text-xl font-semibold text-[var(--color-text)]">{preview.title}</h1><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-text-secondary)]"><span>{preview.messageCount} 条消息</span><span>创建于 {new Date(preview.createdAt).toLocaleString()}</span><span>有效期：{formatTime(preview.expiresAt)}</span></div></div>
          <PublicShareMessageList snapshot={preview.snapshot} />
        </main>
      </div>}
    </Modal>
  );
}
