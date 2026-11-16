import type { SharePreviewResponseDto } from '../../generated/relay-contracts';
import { useEffect, useState } from 'react';
import RelayLogo from '../brand/RelayLogo';
import Modal from '../ui/Modal';
import IconActionButton from '../ui/IconActionButton';
import { ClosePanelIcon } from '../ui/MinimizedPanelBar';
import SharePageContent from './SharePageContent';
import ShareViewControls from './ShareViewControls';

export default function SharePreviewDialog({ preview, onClose }: { preview: SharePreviewResponseDto | null; onClose: () => void }) {
  const [wideLayout, setWideLayout] = useState(false);
  useEffect(() => setWideLayout(false), [preview]);
  return (
    <Modal
      open={preview !== null}
      onClose={onClose}
      labelledBy="share-preview-title"
      contentClassName={`flex max-h-[min(90vh,860px)] w-full ${wideLayout ? 'max-w-none' : 'max-w-4xl'} flex-col overflow-hidden rounded-2xl border border-[var(--color-overlay-border)] bg-[var(--color-overlay-surface)] shadow-[var(--color-overlay-shadow)]`}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <div><h2 id="share-preview-title" className="text-sm font-semibold text-[var(--color-text)]">分享页面预览</h2><p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">仅供当前用户查看，不会创建分享或公开链接。</p></div>
        <IconActionButton label="关闭预览" variant="neutral" tooltip={false} className="h-8 w-8" onClick={onClose}><ClosePanelIcon /></IconActionButton>
      </div>
      {preview && <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-bg)]">
        <header className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 backdrop-blur">
          <div className={`mx-auto flex ${wideLayout ? 'max-w-none' : 'max-w-4xl'} items-center justify-between gap-4 px-4 py-3`}>
            <div className="flex min-w-0 items-center gap-3"><RelayLogo className="h-8 w-8" /><div className="text-sm font-semibold text-[var(--color-text)]">Relay 分享</div></div>
            <div className="flex shrink-0 items-center gap-1"><span className="whitespace-nowrap rounded-full border border-[var(--color-notice-info-border)] bg-[var(--color-notice-info-bg)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)]">预览</span><ShareViewControls wideLayout={wideLayout} onToggleWide={() => setWideLayout(value => !value)} /></div>
          </div>
        </header>
        <SharePageContent data={preview} preview wideLayout={wideLayout} />
      </div>}
    </Modal>
  );
}
