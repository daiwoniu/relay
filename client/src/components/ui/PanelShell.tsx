import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import Modal from './Modal';
import IconActionButton from './IconActionButton';
import MinimizedPanelBar, { MinimizePanelIcon } from './MinimizedPanelBar';
import { featureAction } from '../../analytics/features';
import type { AnalyticsFeature } from '../../../../server/src/analytics/registry';

export const PanelReturnContext = createContext<(panelId: string) => (() => void) | undefined>(() => undefined);

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
  minimizedTitle,
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
  mobileFitContent = false,
  size = 'content',
  bodyClassName = '',
  footerClassName = '',
  closeDisabled = false,
  onNavigateBack,
  backLabel = '返回管理中心',
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
  minimizedTitle?: string;
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
  mobileFitContent?: boolean;
  size?: PanelShellSize;
  bodyClassName?: string;
  footerClassName?: string;
  closeDisabled?: boolean;
  onNavigateBack?: () => void;
  backLabel?: string;
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
  const returnToParent = useContext(PanelReturnContext)(titleId);
  const onBack = onNavigateBack ?? returnToParent;
  const [minimized, setMinimized] = useState(false);
  const contentRegion = useRef<HTMLDivElement>(null);
  const savedScroll = useRef<Array<{ element: Element; top: number; left: number }>>([]);
  useLayoutEffect(() => {
    if (!open) {
      savedScroll.current = [];
      return;
    }
    if (minimized) return;
    for (const { element, top, left } of savedScroll.current) {
      if (element.isConnected) {
        element.scrollTop = top;
        element.scrollLeft = left;
      }
    }
    savedScroll.current = [];
  }, [minimized, open]);
  const [retainMinimizedResult, setRetainMinimizedResult] = useState(false);
  const [visualViewport, setVisualViewport] = useState<CSSProperties>();
  useEffect(() => {
    const viewport = mobile && open && !suspended && !minimized ? window.visualViewport : undefined;
    if (!viewport) {
      setVisualViewport(undefined);
      return;
    }
    const update = () => setVisualViewport(viewport.height < window.innerHeight - 1 ? {
      top: viewport.offsetTop,
      height: viewport.height,
      bottom: 'auto',
    } : undefined);
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, [mobile, minimized, open, suspended]);
  useEffect(() => {
    if (!open) {
      setMinimized(false);
      setRetainMinimizedResult(false);
    }
  }, [open]);
  useEffect(() => {
    if (minimized && minimizedDescriptionActive) setRetainMinimizedResult(true);
  }, [minimized, minimizedDescriptionActive]);
  const minimize = () => {
    if (analyticsFeature) featureAction(analyticsFeature, 'minimize', 'unknown');
    savedScroll.current = [...(contentRegion.current?.querySelectorAll('*') ?? [])]
      .filter(element => element.scrollTop || element.scrollLeft)
      .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }));
    setMinimized(true);
    setRetainMinimizedResult(minimizedDescriptionActive);
  };
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
      containerStyle={mobile ? visualViewport : undefined}
      containerClassName={`panel-shell-layer items-end p-0 sm:items-center sm:p-4 ${mobile ? 'panel-shell-layer--mobile' : ''}`}
      contentClassName={`panel-shell panel-shell--${size} ${SIZE_CLASS[size]} ${mobile ? 'panel-shell--mobile' : ''}${mobile && mobileFitContent ? ' panel-shell--mobile-fit' : ''}`}
    >
      <header className="panel-shell__header">
        <div className="flex min-w-0 items-center gap-3">
          {onBack && <IconActionButton label={backLabel} variant="neutral" className="h-9 w-9 shrink-0" disabled={closeDisabled} onClick={onBack}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 8H3m4-4L3 8l4 4" /></svg></IconActionButton>}
          {icon && <span className="panel-shell__icon" aria-hidden="true">{icon}</span>}
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-base font-semibold tracking-tight text-[var(--color-text)]">{title}</h2>
            {description && <p className="mt-0.5 truncate text-xs text-[var(--color-text-secondary)]">{description}</p>}
          </div>
        </div>
        <div className="panel-shell__header-actions">
          {headerActions}
          {minimizable && <IconActionButton label={`最小化${title}`} tooltip={false} variant="neutral" className="h-9 w-9 rounded-xl" onClick={minimize}><MinimizePanelIcon /></IconActionButton>}
          <IconActionButton label={`关闭${title}`} tooltip={false} variant="neutral" className="h-9 w-9 rounded-xl text-lg" disabled={closeDisabled} onClick={onClose}><span aria-hidden="true">×</span></IconActionButton>
        </div>
      </header>
      {navigation}
      <div ref={contentRegion} className="panel-shell__content">
        {sidebar && <aside className="panel-shell__sidebar">{sidebar}</aside>}
        <div ref={bodyRef} id={bodyId} role={bodyRole} aria-labelledby={bodyLabelledBy} tabIndex={bodyTabIndex} className={`panel-shell__body ${bodyClassName}`}>{children}</div>
      </div>
      {footer && <footer className={`panel-shell__footer ${footerClassName}`}>{footer}</footer>}
    </Modal><MinimizedPanelBar open={open && minimized} panelId={titleId} title={minimizedTitle ?? title} description={minimizedDescriptionActive || retainMinimizedResult ? minimizedDescription ?? description : description} icon={icon} onRestore={restore} onClose={onClose} closeDisabled={closeDisabled} activity={minimizedDescriptionActive ? 'running' : retainMinimizedResult ? 'result' : undefined} /></>
  );
}
