import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { computeFloatingPosition, type FloatingPlacement } from './floating-position';
import { useOverlay } from './OverlayProvider';
import { tooltipTriggerProps } from './tooltip-trigger';
import { hasTooltipOverflow } from './tooltip-overflow';

interface TooltipProps {
  content?: string | null;
  children: ReactNode;
  delay?: number;
  disabled?: boolean;
  placement?: FloatingPlacement;
  className?: string;
  inline?: boolean;
  coexist?: boolean;
  asChild?: boolean;
  /** Full-text hints only; explanatory hints keep their normal behavior. */
  overflowOnly?: boolean;
  /** Restrict clipping checks when the trigger also contains other labels. */
  overflowTarget?: string;
}

function supportsHover() {
  return typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

export default function Tooltip({ content, children, delay = 300, disabled = false, placement = 'top', className = '', inline = false, coexist = false, asChild = false, overflowOnly = false, overflowTarget }: TooltipProps) {
  const tooltipId = useId();
  const overlayId = `tooltip-${tooltipId}`;
  const triggerRef = useRef<HTMLElement | null>(null);
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
    if (disabled || !content) return;
    clearTimer();
    if (overflowOnly && (!triggerRef.current || !hasTooltipOverflow(triggerRef.current, overflowTarget))) return;
    if (immediate) {
      setPositioned(false);
      openTooltip();
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (overflowOnly && (!triggerRef.current || !hasTooltipOverflow(triggerRef.current, overflowTarget))) return;
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
    if (disabled || !content || (overflowOnly && triggerRef.current && !hasTooltipOverflow(triggerRef.current, overflowTarget))) hide();
  }, [disabled, content, overflowOnly, overflowTarget]);

  useEffect(() => {
    if (!visible) return;
    const updateLayout = () => {
      if (overflowOnly && (!triggerRef.current || !hasTooltipOverflow(triggerRef.current, overflowTarget))) {
        hide();
        return;
      }
      updatePosition();
    };
    const observer = overflowOnly && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateLayout) : null;
    if (observer && triggerRef.current) {
      observer.observe(triggerRef.current);
      triggerRef.current.querySelectorAll<HTMLElement>(overflowTarget ?? '*').forEach((element) => observer.observe(element));
    }
    const mutation = overflowOnly && typeof MutationObserver !== 'undefined' ? new MutationObserver(updateLayout) : null;
    if (triggerRef.current) mutation?.observe(triggerRef.current, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'data-tooltip-truncated', 'data-tooltip-full-text', 'hidden'] });
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      hide();
    };
    const frame = requestAnimationFrame(updateLayout);
    document.addEventListener('keydown', dismissOnEscape, true);
    window.addEventListener('resize', updateLayout);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      mutation?.disconnect();
      document.removeEventListener('keydown', dismissOnEscape, true);
      window.removeEventListener('resize', updateLayout);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [updatePosition, visible, content, overflowOnly, overflowTarget]);

  const trigger = asChild && isValidElement<HTMLAttributes<HTMLElement>>(children) && typeof children.type === 'string'
    ? cloneElement(children, tooltipTriggerProps(children.props, {
      enter(event) { triggerRef.current = event.currentTarget; if (event.pointerType !== 'touch' && supportsHover()) show(); },
      focus(event) { triggerRef.current = event.currentTarget; if ((event.target as HTMLElement).matches(':focus-visible')) show(true); },
      hide,
    }, visible ? tooltipId : undefined, content))
    : <span
        ref={(element) => { triggerRef.current = element; }}
        className={`${inline ? 'inline' : 'inline-flex'} ${className}`}
        aria-describedby={visible ? tooltipId : undefined}
        onPointerEnter={(event) => { if (event.pointerType !== 'touch' && supportsHover()) show(); }}
        onPointerLeave={hide}
        onPointerCancel={hide}
        onFocus={(event) => { if ((event.target as HTMLElement).matches(':focus-visible')) show(true); }}
        onBlur={hide}
        onPointerDown={hide}
      >{children}</span>;

  return <>
      {trigger}
      {visible && content && typeof document !== 'undefined' && createPortal(
        <span
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          className="pointer-events-none fixed z-[1100] max-w-[min(32rem,calc(100vw-1rem))] whitespace-pre-line rounded-lg border border-[var(--color-overlay-border)] bg-[var(--color-overlay-surface)] px-2 py-1 text-[11px] font-medium leading-4 text-[var(--color-text-secondary)] shadow-[var(--color-overlay-shadow)] [overflow-wrap:anywhere]"
          style={{ ...position, zIndex: coexist ? 1300 : 1100, visibility: positioned ? 'visible' : 'hidden' }}
        >
          {content}
        </span>,
        document.body,
      )}
    </>;
}
