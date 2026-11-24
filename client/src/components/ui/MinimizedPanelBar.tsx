import Tooltip from './Tooltip';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { registerMinimizedPanel } from './minimizedPanelRegistry';
import useMinimizedPanelSlot, { focusMinimizedPanelSlot } from './useMinimizedPanelSlot';

export function RestorePanelIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 4.5h6.5v7H5zM3.5 10V3.5H10" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" strokeLinecap="round"/></svg>;
}

export function ClosePanelIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>;
}

export default function MinimizedPanelBar({ open, panelId, title, description = '内容已保留，可随时继续', icon, onRestore, onClose, closeDisabled = false, activity, restoreLabel, closeLabel, primaryAction, announceDescription = Boolean(activity), descriptionClassName }: {
  open: boolean;
  panelId?: string;
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  onRestore: () => void;
  onClose: () => void;
  closeDisabled?: boolean;
  activity?: 'running' | 'result';
  restoreLabel?: string;
  closeLabel?: string;
  announceDescription?: boolean;
  descriptionClassName?: string;
  primaryAction?: { label: string; onClick: () => void; disabled?: boolean };
}) {
  const slot = useMinimizedPanelSlot(open, activity);
  const restoreRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open || !slot) return;
    const frame = requestAnimationFrame(() => focusMinimizedPanelSlot(restoreRef.current, slot));
    return () => cancelAnimationFrame(frame);
  }, [open, slot]);

  useEffect(() => {
    if (!open || !panelId) return;
    return registerMinimizedPanel(panelId, onRestore);
  }, [open, panelId, onRestore]);

  if (!open || !slot) return null;
  const restoreText = restoreLabel ?? `恢复${title}`;
  const closeText = closeLabel ?? `关闭${title}`;
  return createPortal(
    <div role="region" aria-label={`${title}已最小化`} data-panel-id={panelId} className="minimized-panel-bar">
      <div className="minimized-panel-bar__identity">
        <span className="minimized-panel-bar__icon" aria-hidden="true">{icon}</span>
        <span className="minimized-panel-bar__copy"><strong className="minimized-panel-bar__title">{title}</strong><span className={`minimized-panel-bar__description${descriptionClassName ? ` ${descriptionClassName}` : ''}`} aria-live={announceDescription ? 'polite' : undefined}>{description}</span></span>
      </div>
      <div className="minimized-panel-bar__actions">
        {primaryAction && <button type="button" onClick={primaryAction.onClick} disabled={primaryAction.disabled} className="minimized-panel-bar__primary">{primaryAction.label}</button>}
        <Tooltip content={restoreText} asChild><button ref={restoreRef} type="button" onClick={onRestore} aria-label={restoreText} className="minimized-panel-bar__restore"><RestorePanelIcon /></button></Tooltip>
        <Tooltip content={closeText} asChild><button type="button" onClick={onClose} disabled={closeDisabled} aria-label={closeText} className="minimized-panel-bar__close"><ClosePanelIcon /></button></Tooltip>
      </div>
    </div>,
    slot,
  );
}
