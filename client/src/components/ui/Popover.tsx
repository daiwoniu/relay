import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { computeFloatingPosition, type FloatingPlacement } from './floating-position';
import { useOverlay } from './OverlayProvider';
import { shouldClosePopoverForWindowResize } from './popover-resize';
import { shouldClosePopoverForScroll } from './popover-scroll';

interface PopoverProps {
  open: boolean;
  anchorRect: DOMRect | null;
  children: ReactNode;
  onClose: () => void;
  placement?: FloatingPlacement;
  mobile?: boolean;
  mobilePresentation?: 'floating' | 'sheet';
  label?: string;
  className?: string;
  closeOnMouseLeave?: boolean;
  desktopStyle?: CSSProperties;
  gap?: number;
}

export default function Popover({
  open,
  anchorRect,
  children,
  onClose,
  placement = 'bottom',
  mobile = false,
  mobilePresentation = 'floating',
  label = '弹出内容',
  className = '',
  closeOnMouseLeave = false,
  desktopStyle,
  gap = 6,
}: PopoverProps) {
  const generatedId = useId();
  const overlayId = `popover-${generatedId}`;
  const popoverRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const requestClose = useCallback(() => onCloseRef.current(), []);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const [positioned, setPositioned] = useState(false);
  const [mobileSheetMaxHeight, setMobileSheetMaxHeight] = useState<string | undefined>();
  const { openOverlay, closeOverlay, registerOverlayCloser, isOverlayOpen } = useOverlay();
  const visible = open && isOverlayOpen('popover', overlayId);
  const mobileSheet = mobile && mobilePresentation === 'sheet';

  useEffect(() => {
    if (!open || !mobileSheet) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const restoreTarget = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restoreTarget?.isConnected) restoreTarget.focus();
    };
  }, [mobileSheet, open]);

  useEffect(() => {
    if (!open || !mobileSheet) return;
    const viewport = window.visualViewport;
    const update = () => {
      const availableHeight = Math.min(viewport?.height ?? window.innerHeight, window.innerHeight);
      setMobileSheetMaxHeight(`${Math.max(240, availableHeight - 16)}px`);
    };
    update();
    viewport?.addEventListener('resize', update);
    return () => viewport?.removeEventListener('resize', update);
  }, [mobileSheet, open]);

  const cancelLeaveClose = () => {
    if (!leaveTimerRef.current) return;
    clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = null;
  };

  const scheduleLeaveClose = () => {
    if (mobile || !closeOnMouseLeave) return;
    cancelLeaveClose();
    leaveTimerRef.current = setTimeout(() => {
      leaveTimerRef.current = null;
      requestClose();
    }, 180);
  };

  const updatePosition = useCallback(() => {
    const floating = popoverRef.current?.getBoundingClientRect();
    if (!anchorRect || !floating || mobile) return;
    setPosition(computeFloatingPosition(
      anchorRect,
      floating,
      { width: window.innerWidth, height: window.innerHeight },
      { preferredPlacement: placement, gap, padding: 8 },
    ));
    setPositioned(true);
  }, [anchorRect, gap, mobile, placement]);

  useEffect(() => {
    if (!open) return;
    setPositioned(mobile);
    openOverlay('popover', overlayId);
    const unregisterCloser = registerOverlayCloser('popover', overlayId, requestClose);
    const frame = requestAnimationFrame(updatePosition);
    const handlePointerDown = (event: MouseEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) requestClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }
      if (!mobileSheet || event.key !== 'Tab') return;
      const focusable = [...(popoverRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])];
      if (focusable.length === 0) {
        event.preventDefault();
        popoverRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const handleScroll = (event: Event) => {
      if (shouldClosePopoverForScroll(popoverRef.current, event.target)) requestClose();
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
      closeOverlay('popover', overlayId);
    };
  }, [closeOverlay, mobile, mobileSheet, open, openOverlay, overlayId, registerOverlayCloser, requestClose, updatePosition]);

  useEffect(() => {
    if (!visible || !mobileSheet) return;
    const frame = requestAnimationFrame(() => {
      const firstFocusable = popoverRef.current?.querySelector<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])');
      (firstFocusable ?? popoverRef.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [mobileSheet, visible]);

  useEffect(() => {
    if (!visible || mobile) return;
    const popover = popoverRef.current;
    let frame = requestAnimationFrame(updatePosition);
    if (!popover || typeof ResizeObserver === 'undefined') {
      return () => cancelAnimationFrame(frame);
    }

    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updatePosition);
    });
    observer.observe(popover);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [mobile, updatePosition, visible]);

  if (!visible || typeof document === 'undefined') return null;

  const content = (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={label}
      aria-modal={mobile ? true : undefined}
      tabIndex={-1}
      onMouseEnter={cancelLeaveClose}
      onMouseLeave={scheduleLeaveClose}
      className={mobile
        ? `popover-surface ${mobileSheet ? 'popover-surface--mobile-sheet' : 'popover-surface--mobile-floating'} fixed z-[1150] overflow-hidden ${className}`
        : `popover-surface popover-surface--desktop fixed z-[1150] overflow-hidden ${className}`}
      style={mobile ? (mobileSheet ? { maxHeight: mobileSheetMaxHeight } : undefined) : { ...desktopStyle, ...position, visibility: positioned ? 'visible' : 'hidden' }}
    >
      {children}
    </div>
  );

  return createPortal(
    mobile ? (
      <div className="fixed inset-0 z-[1140] bg-[var(--color-backdrop)]" onMouseDown={requestClose}>
        <div onMouseDown={(event) => event.stopPropagation()}>{content}</div>
      </div>
    ) : content,
    document.body,
  );
}
