import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { computeFloatingPosition, type FloatingPlacement } from './floating-position';
import { useOverlay } from './OverlayProvider';

interface HoverCardProps {
  children: ReactNode;
  title: ReactNode;
  content: ReactNode;
  disabled?: boolean;
  delay?: number;
  placement?: FloatingPlacement;
  className?: string;
  maxWidth?: string;
  openOnClick?: boolean;
}

function supportsHover() {
  return typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

export default function HoverCard({
  children,
  title,
  content,
  disabled = false,
  delay = 600,
  placement = 'right',
  className = '',
  maxWidth,
  openOnClick = false,
}: HoverCardProps) {
  const generatedId = useId();
  const overlayId = `hover-card-${generatedId}`;
  const triggerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [positioned, setPositioned] = useState(false);
  const { openOverlay, closeOverlay, isOverlayOpen } = useOverlay();
  const visible = isOverlayOpen('hover-card', overlayId);

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };

  const cancelPendingOpen = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
  };

  const updatePosition = useCallback(() => {
    const anchor = triggerRef.current?.getBoundingClientRect();
    const floating = cardRef.current?.getBoundingClientRect();
    if (!anchor || !floating) return;
    setPosition(computeFloatingPosition(
      anchor,
      floating,
      { width: window.innerWidth, height: window.innerHeight },
      { preferredPlacement: placement, gap: 4, padding: 8 },
    ));
    setPositioned(true);
  }, [placement]);

  const open = (immediate = false) => {
    if (disabled) return;
    if (immediate) cancelPendingOpen();
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (visible) return;
    if (immediate) {
      setPositioned(false);
      openOverlay('hover-card', overlayId);
      return;
    }
    if (openTimer.current) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setPositioned(false);
      openOverlay('hover-card', overlayId);
    }, delay);
  };

  const close = (withDelay = false) => {
    cancelPendingOpen();
    if (withDelay) {
      closeTimer.current = setTimeout(() => {
        closeTimer.current = null;
        setPositioned(false);
        closeOverlay('hover-card', overlayId);
      }, 250);
      return;
    }
    setPositioned(false);
    closeOverlay('hover-card', overlayId);
  };

  useEffect(() => () => {
    clearTimers();
    closeOverlay('hover-card', overlayId);
  }, [closeOverlay, overlayId]);

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(updatePosition);
    const handleViewportChange = () => updatePosition();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    window.visualViewport?.addEventListener('resize', handleViewportChange);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
      window.visualViewport?.removeEventListener('resize', handleViewportChange);
    };
  }, [updatePosition, visible]);

  return (
    <div
      ref={triggerRef}
      className={className}
      onMouseMove={(event) => {
        if (!supportsHover()) return;
        const target = event.target as HTMLElement;
        if (target.closest('[data-overlay-ignore]')) cancelPendingOpen();
        else open();
      }}
      onMouseLeave={() => close(true)}
      onClickCapture={(event) => {
        if (!openOnClick) return;
        const target = event.target as HTMLElement;
        if (!target.closest('[data-overlay-ignore]')) open(true);
      }}
      onFocusCapture={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest('[data-overlay-ignore]') && target.matches(':focus-visible')) open(true);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(true);
      }}
    >
      {children}
      {visible && typeof document !== 'undefined' && createPortal(
        <div
          ref={cardRef}
          role="dialog"
          aria-modal="false"
          aria-label={typeof title === 'string' ? title : '详细信息'}
          className="info-panel-surface info-panel-surface--hover fixed z-[1050] w-max min-w-[min(10rem,calc(100vw-1rem))] max-w-[min(16rem,calc(100vw-1rem))] select-text text-xs"
          style={{ ...position, maxWidth, visibility: positioned ? 'visible' : 'hidden' }}
          onMouseEnter={() => open(true)}
          onMouseLeave={() => close(true)}
        >
          <div className="info-panel__header"><div className="info-panel__title">{title}</div></div>
          <div className="info-panel__body">{content}</div>
        </div>,
        document.body,
      )}
    </div>
  );
}
