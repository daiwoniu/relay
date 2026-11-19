import { useEffect, useState, type ReactNode, type Ref } from 'react';
import Modal from './Modal';
import IconActionButton from './IconActionButton';
import MinimizedPanelBar from './MinimizedPanelBar';
import { featureAction } from '../../analytics/features';
import type { AnalyticsFeature } from '../../../../server/src/analytics/registry';

export type PanelShellSize = 'settings' | 'content' | 'operations' | 'compact';

const SIZE_CLASS: Record<PanelShellSize, string> = {
  settings: 'max-w-[960px]',
  content: 'max-w-[820px]',
  operations: 'max-w-[780px]',
  compact: 'max-w-[480px]',
};

export default function PanelShell({
  open,
  onClose,
  title,
  description,
  minimizedDescription,
  minimizedDescriptionActive = false,
  titleId,
  icon,
  headerActions,
  navigation,
  sidebar,
  children,
  footer,
  mobile = false,
  size = 'content',
  bodyClassName = '',
  footerClassName = '',
  closeDisabled = false,
  closeOnBackdrop = true,
  closeOnEscape = true,
  suspended = false,
  minimizable = true,
  bodyId,
  bodyRole,
  bodyLabelledBy,
  bodyTabIndex,
  bodyRef,
  analyticsFeature,
}: {
  analyticsFeature?:AnalyticsFeature;
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  minimizedDescription?: ReactNode;
  minimizedDescriptionActive?: boolean;
  titleId: string;
  icon?: ReactNode;
  headerActions?: ReactNode;
  navigation?: ReactNode;
  sidebar?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  mobile?: boolean;
  size?: PanelShellSize;
  bodyClassName?: string;
  footerClassName?: string;
  closeDisabled?: boolean;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  suspended?: boolean;
  minimizable?: boolean;
  bodyId?: string;
  bodyRole?: 'tabpanel';
  bodyLabelledBy?: string;
  bodyTabIndex?: number;
  bodyRef?: Ref<HTMLDivElement>;
}) {
  const [minimized, setMinimized] = useState(false);
  const [retainMinimizedResult, setRetainMinimizedResult] = useState(false);
  useEffect(() => {
    if (!open) {
      setMinimized(false);
      setRetainMinimizedResult(false);
    }
  }, [open]);
  useEffect(() => {
    if (minimized && minimizedDescriptionActive) setRetainMinimizedResult(true);
  }, [minimized, minimizedDescriptionActive]);
  const restore = () => {
    if(minimized&&analyticsFeature)featureAction(analyticsFeature,'restore','unknown');
    setMinimized(false);
    setRetainMinimizedResult(false);
  };

  return (
    <><Modal
      open={open}
      onClose={onClose}
      closeOnBackdrop={closeOnBackdrop}
      closeOnEscape={closeOnEscape}
      suspended={suspended || minimized}
      labelledBy={titleId}
      containerClassName={`panel-shell-layer items-end p-0 sm:items-center sm:p-4 ${mobile ? 'panel-shell-layer--mobile' : ''}`}
      contentClassName={`panel-shell panel-shell--${size} ${SIZE_CLASS[size]} ${mobile ? 'panel-shell--mobile' : ''}`}
    >
      <header className="panel-shell__header">
        <div className="flex min-w-0 items-center gap-3">
          {icon && <span className="panel-shell__icon" aria-hidden="true">{icon}</span>}
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-base font-semibold tracking-tight text-[var(--color-text)]">{title}</h2>
            {description && <p className="mt-0.5 truncate text-xs text-[var(--color-text-secondary)]">{description}</p>}
          </div>
        </div>
        <div className="panel-shell__header-actions">
          {headerActions}
          {minimizable && <IconActionButton label={`最小化${title}`} tooltip={false} variant="neutral" className="h-9 w-9 rounded-xl" onClick={() => { if(!minimized&&analyticsFeature)featureAction(analyticsFeature,'minimize','unknown');setMinimized(true); setRetainMinimizedResult(minimizedDescriptionActive); }}><svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 11.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></IconActionButton>}
          <IconActionButton label={`关闭${title}`} tooltip={false} variant="neutral" className="h-9 w-9 rounded-xl text-lg" disabled={closeDisabled} onClick={onClose}><span aria-hidden="true">×</span></IconActionButton>
        </div>
      </header>
      {navigation}
      <div className="panel-shell__content">
        {sidebar && <aside className="panel-shell__sidebar">{sidebar}</aside>}
        <div ref={bodyRef} id={bodyId} role={bodyRole} aria-labelledby={bodyLabelledBy} tabIndex={bodyTabIndex} className={`panel-shell__body ${bodyClassName}`}>{children}</div>
      </div>
      {footer && <footer className={`panel-shell__footer ${footerClassName}`}>{footer}</footer>}
    </Modal><MinimizedPanelBar open={open && minimized} panelId={titleId} title={title} description={minimizedDescriptionActive || retainMinimizedResult ? minimizedDescription ?? description : description} icon={icon} onRestore={restore} onClose={onClose} closeDisabled={closeDisabled} /></>
  );
}
