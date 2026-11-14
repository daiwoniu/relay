import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { computeFloatingPosition, type FloatingPlacement } from './floating-position';
import { useOverlay } from './OverlayProvider';

interface TooltipProps {
  content: string;
  children: ReactNode;
  delay?: number;
  disabled?: boolean;
  placement?: FloatingPlacement;
  className?: string;
  inline?: boolean;
  coexist?: boolean;
}

function supportsHover() {
  return typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

export default function Tooltip({ content, children, delay = 300, disabled = false, placement = 'top', className = '', inline = false, coexist = false }: TooltipProps) {
  const tooltipId = useId();
  const overlayId = `tooltip-${tooltipId}`;
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [positioned, setPositioned] = useState(false);
  const [coexistingVisible, setCoexistingVisible] = useState(false);
  const { openOverlay, closeOverlay, isOverlayOpen } = useOverlay();
  const visible = coexist ? coexistingVisible : isOverlayOpen('tooltip', overlayId);
  const openTooltip = () => {
    if (coexist) {
      setCoexistingVisible(true);
    } else {
      openOverlay('tooltip', overlayId);
    }
  };
  const closeTooltip = () => {
    if (coexist) setCoexistingVisible(false);
    else closeOverlay('tooltip', overlayId);
  };

  const clearTimer = () => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    const floating = tooltipRef.current?.getBoundingClientRect();
    if (!rect || !floating) return;
    setPosition(computeFloatingPosition(
      rect,
      floating,
      { width: window.innerWidth, height: window.innerHeight },
      { preferredPlacement: placement, gap: 6, padding: 8 },
    ));
    setPositioned(true);
  }, [placement]);

  const show = (immediate = false) => {
    if (disabled) return;
    clearTimer();
    if (immediate) {
      setPositioned(false);
      openTooltip();
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setPositioned(false);
      openTooltip();
    }, delay);
  };

  const hide = () => {
    clearTimer();
    setPositioned(false);
    closeTooltip();
  };

  useEffect(() => () => {
    clearTimer();
    if (!coexist) closeOverlay('tooltip', overlayId);
  }, [closeOverlay, coexist, overlayId]);

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [updatePosition, visible]);

  return (
    <span
      ref={triggerRef}
      className={`${inline ? 'inline' : 'inline-flex'} ${className}`}
      aria-describedby={visible ? tooltipId : undefined}
      onMouseEnter={() => { if (supportsHover()) show(); }}
      onMouseLeave={hide}
      onFocus={(event) => { if ((event.target as HTMLElement).matches(':focus-visible')) show(true); }}
      onBlur={hide}
    >
      {children}
      {visible && typeof document !== 'undefined' && createPortal(
        <span
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          className="pointer-events-none fixed z-[1100] max-w-[min(32rem,calc(100vw-1rem))] whitespace-normal rounded-lg border border-[var(--color-overlay-border)] bg-[var(--color-overlay-surface)] px-2 py-1 text-[11px] font-medium leading-4 text-[var(--color-text-secondary)] shadow-[var(--color-overlay-shadow)] [overflow-wrap:anywhere]"
          style={{ ...position, zIndex: coexist ? 1300 : 1100, visibility: positioned ? 'visible' : 'hidden' }}
        >
          {content}
        </span>,
        document.body,
      )}
    </span>
  );
}
