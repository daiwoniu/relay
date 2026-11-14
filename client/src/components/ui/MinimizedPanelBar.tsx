import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { registerMinimizedPanel } from './minimizedPanelRegistry';
import useMinimizedPanelSlot from './useMinimizedPanelSlot';

export function RestorePanelIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 4.5h6.5v7H5zM3.5 10V3.5H10" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" strokeLinecap="round"/></svg>;
}

export function ClosePanelIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>;
}

export default function MinimizedPanelBar({ open, panelId, title, description = '内容已保留，可随时继续', icon, onRestore, onClose, closeDisabled = false }: {
  open: boolean;
  panelId?: string;
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  onRestore: () => void;
  onClose: () => void;
  closeDisabled?: boolean;
}) {
  const slot = useMinimizedPanelSlot(open);
  const restoreRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open || !slot) return;
    const frame = requestAnimationFrame(() => restoreRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open, slot]);

  useEffect(() => {
    if (!open || !panelId) return;
    return registerMinimizedPanel(panelId, onRestore);
  }, [open, panelId, onRestore]);

  if (!open || !slot) return null;
  return createPortal(
    <div role="region" aria-label={`${title}已最小化`} data-panel-id={panelId} className="minimized-panel-bar">
      <div className="minimized-panel-bar__identity">
        <span className="minimized-panel-bar__icon" aria-hidden="true">{icon}</span>
        <span className="minimized-panel-bar__copy"><strong className="minimized-panel-bar__title">{title}</strong><span className="minimized-panel-bar__description">{description}</span></span>
      </div>
      <div className="minimized-panel-bar__actions"><button ref={restoreRef} type="button" onClick={onRestore} aria-label={`恢复${title}`} title={`恢复${title}`} className="minimized-panel-bar__restore"><RestorePanelIcon /></button><button type="button" onClick={onClose} disabled={closeDisabled} aria-label={`关闭${title}`} title={`关闭${title}`} className="minimized-panel-bar__close"><ClosePanelIcon /></button></div>
    </div>,
    slot,
  );
}
