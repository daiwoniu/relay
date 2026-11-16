import Tooltip from '../ui/Tooltip';
import { useState, type ReactNode } from 'react';
import Modal from '../ui/Modal';
import IconActionButton from '../ui/IconActionButton';
import MinimizedPanelBar from '../ui/MinimizedPanelBar';

interface Props {
  labelledBy: string;
  title: string;
  subtitle?: string;
  onClose: () => void;
  onBack?: () => void;
  backDisabled?: boolean;
  headerActions?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  widthClassName?: string;
}

export default function FilePickerShell({ labelledBy, title, subtitle, onClose, onBack, backDisabled = false, headerActions, footer, children, widthClassName = 'w-[640px]' }: Props) {
  const [minimized, setMinimized] = useState(false);
  return (
    <><Modal open suspended={minimized} onClose={onClose} labelledBy={labelledBy} containerClassName="max-sm:items-end max-sm:p-0" contentClassName={`file-picker-shell flex h-[80vh] max-h-[560px] ${widthClassName} max-w-full flex-col overflow-hidden`}>
      <div className="file-picker-shell__header">
        <div className="flex min-w-0 items-center gap-2">
          {onBack && <IconActionButton label="返回上一级" variant="neutral" onClick={onBack} disabled={backDisabled}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></IconActionButton>}
          <div className="min-w-0">
            <h2 id={labelledBy} className="text-sm font-semibold text-[var(--color-text)]">{title}</h2>
            {subtitle && <Tooltip content={subtitle} asChild><div className="mt-0.5 truncate text-xs text-[var(--color-text-tertiary)]">{subtitle}</div></Tooltip>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {headerActions}
          <IconActionButton label={`最小化${title}`} variant="neutral" onClick={() => setMinimized(true)}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 11.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></IconActionButton>
          <IconActionButton label={`关闭${title}`} variant="neutral" onClick={onClose}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></IconActionButton>
        </div>
      </div>
      <div className="file-picker-shell__body">{children}</div>
      <div className="file-picker-shell__footer">{footer}</div>
    </Modal><MinimizedPanelBar open={minimized} panelId={labelledBy} title={title} description={subtitle || '已保留当前选择'} onRestore={() => setMinimized(false)} onClose={onClose} /></>
  );
}
