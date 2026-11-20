import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { computeFloatingPosition } from './floating-position';
import { shouldRestoreOverlayFocus } from './focus-restoration';
import { useOverlay } from './OverlayProvider';
import { shouldClosePopoverForWindowResize } from './popover-resize';
import { shouldClosePopoverForScroll } from './popover-scroll';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSelect: () => void | Promise<void>;
}

interface ContextMenuProps {
  open: boolean;
  anchorRect: DOMRect | null;
  items: ContextMenuItem[];
  onClose: () => void;
  mobile?: boolean;
  label?: string;
}

export default function ContextMenu({ open, anchorRect, items, onClose, mobile = false, label = '操作菜单' }: ContextMenuProps) {
  const generatedId = useId();
  const overlayId = `context-menu-${generatedId}`;
  const menuRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const requestClose = useCallback(() => onCloseRef.current(), []);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const [positioned, setPositioned] = useState(false);
  const { openOverlay, closeOverlay, registerOverlayCloser } = useOverlay();

  const cancelLeaveClose = () => {
    if (!leaveTimerRef.current) return;
    clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = null;
  };

  const scheduleLeaveClose = () => {
    if (mobile) return;
    cancelLeaveClose();
    leaveTimerRef.current = setTimeout(() => {
      leaveTimerRef.current = null;
      requestClose();
    }, 180);
  };

  useEffect(() => {
    if (!open) return;
    cancelLeaveClose();
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openOverlay('context-menu', overlayId);
    const unregisterCloser = registerOverlayCloser('context-menu', overlayId, requestClose);
    const frame = requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (!menu) return;
      if (!mobile && anchorRect) {
        setPosition(computeFloatingPosition(
          anchorRect,
          menu.getBoundingClientRect(),
          { width: window.innerWidth, height: window.innerHeight },
          { preferredPlacement: 'right', gap: 4, padding: 8 },
        ));
      }
      setPositioned(true);
      menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });

    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) requestClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      if (buttons.length === 0) return;
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Home') buttons[0].focus();
      else if (event.key === 'End') buttons[buttons.length - 1].focus();
      else if (event.key === 'ArrowDown') buttons[(current + 1 + buttons.length) % buttons.length].focus();
      else buttons[(current - 1 + buttons.length) % buttons.length].focus();
    };
    const handleScroll = (event: Event) => {
      if (shouldClosePopoverForScroll(menuRef.current, event.target)) requestClose();
    };
    const handleResize = () => {
      if (shouldClosePopoverForWindowResize(mobile)) requestClose();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    if (!mobile) window.addEventListener('scroll', handleScroll, true);
    return () => {
      setPositioned(false);
      cancelLeaveClose();
      cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
      if (!mobile) window.removeEventListener('scroll', handleScroll, true);
      unregisterCloser();
      closeOverlay('context-menu', overlayId);
      const restoreFocusTarget = restoreFocusRef.current;
      if (
        restoreFocusTarget?.isConnected
        && shouldRestoreOverlayFocus(document.activeElement, document.body)
      ) {
        restoreFocusTarget.focus();
      }
    };
  }, [anchorRect, closeOverlay, mobile, requestClose, open, openOverlay, overlayId, registerOverlayCloser]);

  if (!open || typeof document === 'undefined') return null;

  const menu = (
    <div
      ref={menuRef}
      data-overlay-root
      role="menu"
      aria-label={label}
      onMouseEnter={cancelLeaveClose}
      onMouseLeave={scheduleLeaveClose}
      className={mobile
        ? 'fixed inset-x-3 bottom-3 z-[1150] overflow-hidden rounded-2xl border border-[var(--color-overlay-border)] bg-[var(--color-overlay-surface)] py-1 shadow-[var(--color-overlay-shadow)]'
        : 'fixed z-[1150] w-44 overflow-hidden rounded-xl border border-[var(--color-overlay-border)] bg-[var(--color-overlay-surface)] py-1 shadow-[var(--color-overlay-shadow)]'}
      style={mobile ? undefined : { ...position, visibility: positioned ? 'visible' : 'hidden' }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          aria-disabled={item.disabled || undefined}
          onClick={() => {
            if (item.disabled) return;
            requestClose();
            void item.onSelect();
          }}
          className={`flex w-full items-start gap-2 px-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus-ring)] ${mobile ? 'min-h-11 py-3' : 'min-h-9 py-2'} ${item.disabled
            ? 'cursor-not-allowed text-[var(--color-text-tertiary)]'
            : item.danger
              ? 'text-[var(--color-danger-text)] hover:bg-[var(--color-danger-hover)]'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]'}`}
        >
          {item.icon && <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">{item.icon}</span>}
          <span className="min-w-0 flex-1">
            <span className="block text-sm">{item.label}</span>
            {item.disabledReason && <span className="mt-0.5 block text-[11px] leading-4 text-[var(--color-text-tertiary)]">{item.disabledReason}</span>}
          </span>
        </button>
      ))}
    </div>
  );

  return createPortal(
    mobile ? (
      <div data-overlay-root className="fixed inset-0 z-[1140] bg-[var(--color-backdrop)]" onMouseDown={requestClose}>
        <div onMouseDown={(event) => event.stopPropagation()}>{menu}</div>
      </div>
    ) : menu,
    document.body,
  );
}
