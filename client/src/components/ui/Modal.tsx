import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useOverlay } from './OverlayProvider';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  contentClassName?: string;
  containerClassName?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  role?: 'dialog' | 'alertdialog';
  labelledBy?: string;
  describedBy?: string;
  suspended?: boolean;
}

export default function Modal({
  open,
  onClose,
  children,
  contentClassName = '',
  containerClassName = '',
  closeOnBackdrop = true,
  closeOnEscape = true,
  role = 'dialog',
  labelledBy,
  describedBy,
  suspended = false,
}: ModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const closeOnEscapeRef = useRef(closeOnEscape);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const generatedId = useId();
  const overlayId = `dialog-${generatedId}`;
  const { openOverlay, closeOverlay, registerOverlayCloser } = useOverlay();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    closeOnEscapeRef.current = closeOnEscape;
  }, [closeOnEscape]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const restoreTarget = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restoreTarget?.isConnected) restoreTarget.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open || suspended) return;
    openOverlay('dialog', overlayId);
    const unregisterCloser = registerOverlayCloser('dialog', overlayId, () => onCloseRef.current());
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusFrame = requestAnimationFrame(() => {
      const content = contentRef.current;
      const preferred = content?.querySelector<HTMLElement>('[data-autofocus]');
      const firstFocusable = content?.querySelector<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])');
      (preferred ?? firstFocusable ?? content)?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closeOnEscapeRef.current) onCloseRef.current();
      if (event.key !== 'Tab') return;
      const focusable = [...(contentRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])];
      if (focusable.length === 0) {
        event.preventDefault();
        contentRef.current?.focus();
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
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      unregisterCloser();
      closeOverlay('dialog', overlayId);
    };
  }, [closeOverlay, open, openOverlay, overlayId, registerOverlayCloser, suspended]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      data-overlay-root
      className={suspended ? 'hidden' : `fixed inset-0 z-[1200] flex items-center justify-center bg-[var(--color-backdrop)] p-4 ${containerClassName}`}
      onClick={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={contentRef}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={`outline-none ${contentClassName}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
