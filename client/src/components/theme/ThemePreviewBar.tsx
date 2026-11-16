import Tooltip from '../ui/Tooltip';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ClosePanelIcon, RestorePanelIcon } from '../ui/MinimizedPanelBar';
import { registerMinimizedPanel } from '../ui/minimizedPanelRegistry';
import useMinimizedPanelSlot from '../ui/useMinimizedPanelSlot';

interface ThemePreviewBarProps {
  open: boolean;
  mobile?: boolean;
  saving?: boolean;
  saveDisabled?: boolean;
  conflict?: boolean;
  onRestore: () => void;
  onSave: () => void;
  onCancel: () => void;
}

export default function ThemePreviewBar({ open, mobile = false, saving = false, saveDisabled = false, conflict = false, onRestore, onSave, onCancel }: ThemePreviewBarProps) {
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const slot = useMinimizedPanelSlot(open);

  useEffect(() => {
    if (!open || !slot) return;
    const frame = requestAnimationFrame(() => restoreButtonRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open, slot]);

  useEffect(() => {
    if (!open) return;
    return registerMinimizedPanel('account-settings-title', onRestore);
  }, [open, onRestore]);

  if (!open || !slot) return null;

  return createPortal(
    <div className={`theme-surface minimized-panel-bar ${mobile ? 'minimized-panel-bar--mobile' : ''}`} role="region" aria-label="主题预览控制">
        <div className="minimized-panel-bar__identity">
          <span className="minimized-panel-bar__icon relative text-[var(--color-brand-mark)]">
            <span className="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-status-processing)]" />
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.2a5.8 5.8 0 105.8 5.8c0-.7-.6-1.1-1.2-.8l-.9.4a1.2 1.2 0 01-1.6-1.6l.4-.9c.3-.6-.1-1.2-.8-1.2H8z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><circle cx="5.2" cy="6" r=".7" fill="currentColor"/><circle cx="7.1" cy="4.2" r=".7" fill="currentColor"/></svg>
          </span>
          <span className="minimized-panel-bar__copy">
            <strong className="minimized-panel-bar__title">主题预览中</strong>
            <span aria-live="polite" className={`minimized-panel-bar__description ${conflict ? 'text-[var(--color-status-warning)]' : ''}`}>{conflict ? '其他设备已更新，请返回编辑处理' : '尚未保存，可浏览完整页面效果'}</span>
          </span>
        </div>
        <div className="minimized-panel-bar__actions">
          <button type="button" onClick={onSave} disabled={saving || saveDisabled} className="minimized-panel-bar__primary text-[var(--theme-on-primary)]">{saving ? '保存中…' : '保存主题'}</button>
          <Tooltip content="返回编辑" asChild><button ref={restoreButtonRef} type="button" onClick={onRestore} aria-label="返回编辑"><RestorePanelIcon /></button></Tooltip>
          <Tooltip content="关闭主题预览" asChild><button type="button" onClick={onCancel} disabled={saving} aria-label="关闭主题预览" className="minimized-panel-bar__close"><ClosePanelIcon /></button></Tooltip>
        </div>
    </div>,
    slot,
  );
}
