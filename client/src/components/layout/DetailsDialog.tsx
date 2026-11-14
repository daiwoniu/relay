import { useEffect, useState, type ReactNode } from 'react';
import IconActionButton from '../ui/IconActionButton';
import Modal from '../ui/Modal';
import MinimizedPanelBar from '../ui/MinimizedPanelBar';

export default function DetailsDialog({ open, title, description, onClose, children, presentation = 'info', panelId }: {
  open: boolean;
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  presentation?: 'info' | 'task';
  panelId?: string;
}) {
  const [minimized, setMinimized] = useState(false);
  useEffect(() => { if (!open || presentation === 'info') setMinimized(false); }, [open, presentation]);
  const titleId = `details-dialog-${title === '项目详情' ? 'project' : 'session'}`;
  return (
    <><Modal
      open={open}
      suspended={presentation === 'task' && minimized}
      onClose={onClose}
      labelledBy={titleId}
      containerClassName="items-end max-sm:p-0 sm:items-center"
      contentClassName={`details-dialog-surface details-dialog-surface--${presentation} w-full max-w-md ${presentation === 'info' ? 'info-panel-surface info-panel-surface--dialog' : ''}`}
    >
      <div className={`details-dialog__header flex items-center justify-between gap-3 ${presentation === 'info' ? 'info-panel__header' : ''}`}>
        <div className="min-w-0"><div id={titleId} className={`details-dialog__title ${presentation === 'info' ? 'info-panel__title' : ''}`}>{title}</div>{description && <div className="mt-0.5 truncate text-xs text-[var(--color-text-tertiary)]">{description}</div>}</div>
        <div className="flex shrink-0 items-center gap-1">{presentation === 'task' && <IconActionButton label={`最小化${title}`} variant="neutral" tooltip={false} onClick={() => setMinimized(true)} className="h-7 w-7"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 10.5h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></IconActionButton>}
        <IconActionButton label="关闭详情" variant="neutral" tooltip={false} onClick={onClose} className="h-7 w-7">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
        </IconActionButton></div>
      </div>
      <div className={`details-dialog__body ${presentation === 'info' ? 'info-panel__body' : ''}`}>{children}</div>
    </Modal><MinimizedPanelBar open={open && presentation === 'task' && minimized} panelId={panelId ?? titleId} title={title} description={description ?? '操作内容已保留，可随时继续'} onRestore={() => setMinimized(false)} onClose={onClose} /></>
  );
}
