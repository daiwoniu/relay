import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getMobileSidebarSwipeDistance,
  getMobileSidebarSwipeTranslateX,
  isMobileSidebarOpenSwipeStart,
  resolveMobileSidebarSwipeMovement,
  shouldCommitMobileSidebarSwipe,
  type MobileSidebarSwipeMode,
} from './mobile-sidebar-swipe';

interface ActiveSwipe {
  identifier: number;
  mode: MobileSidebarSwipeMode;
  startX: number;
  startY: number;
  startedAt: number;
  panelWidth: number;
  tracking: boolean;
}

interface UseMobileSidebarSwipeOptions {
  enabled: boolean;
  sidebarOpen: boolean;
  blocked: boolean;
  onOpenChange: (open: boolean) => void;
}

const BLOCKED_TARGET_SELECTOR = 'input, textarea, select, option, [contenteditable="true"], [role="slider"], [data-no-sidebar-swipe]';
const BLOCKING_OVERLAY_SELECTOR = '[aria-modal="true"], [role="menu"], [role="dialog"]';

function hasHorizontalScrollContainer(target: Element): boolean {
  let current: Element | null = target;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    if (
      (style.overflowX === 'auto' || style.overflowX === 'scroll')
      && current.scrollWidth > current.clientWidth
    ) return true;
    current = current.parentElement;
  }
  return false;
}

function isBlockedSwipeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest(BLOCKED_TARGET_SELECTOR)) return true;
  if (hasHorizontalScrollContainer(target)) return true;
  return Boolean(window.getSelection()?.toString());
}

export default function useMobileSidebarSwipe({
  enabled,
  sidebarOpen,
  blocked,
  onOpenChange,
}: UseMobileSidebarSwipeOptions) {
  const sidebarRef = useRef<HTMLElement>(null);
  const activeSwipeRef = useRef<ActiveSwipe | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [translateX, setTranslateX] = useState<number | null>(null);

  const clearSwipe = useCallback((nextOpen = sidebarOpen) => {
    activeSwipeRef.current = null;
    onOpenChange(nextOpen);
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = requestAnimationFrame(() => {
      setTranslateX(null);
      animationFrameRef.current = null;
    });
  }, [onOpenChange, sidebarOpen]);

  useEffect(() => {
    if (!enabled || blocked) {
      activeSwipeRef.current = null;
      setTranslateX(null);
      return;
    }

    const suppressNextClick = () => {
      suppressClickRef.current = true;
      if (suppressClickTimerRef.current !== null) window.clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = false;
        suppressClickTimerRef.current = null;
      }, 450);
    };

    const resetWithoutAnimation = () => {
      activeSwipeRef.current = null;
      setTranslateX(null);
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || blocked || document.querySelector(BLOCKING_OVERLAY_SELECTOR)) return;
      const touch = event.touches[0];
      const sidebar = sidebarRef.current;
      const mode: MobileSidebarSwipeMode = sidebarOpen ? 'close' : 'open';
      if (mode === 'open' && !isMobileSidebarOpenSwipeStart(touch.clientX)) return;
      if (mode === 'close' && (!sidebar || !(event.target instanceof Node) || !sidebar.contains(event.target))) return;
      if (isBlockedSwipeTarget(event.target)) return;

      const panelWidth = sidebar?.getBoundingClientRect().width ?? 0;
      if (panelWidth <= 0) return;
      activeSwipeRef.current = {
        identifier: touch.identifier,
        mode,
        startX: touch.clientX,
        startY: touch.clientY,
        startedAt: performance.now(),
        panelWidth,
        tracking: false,
      };
    };

    const handleTouchMove = (event: TouchEvent) => {
      const activeSwipe = activeSwipeRef.current;
      if (!activeSwipe) return;
      const touch = Array.from(event.touches).find((candidate) => candidate.identifier === activeSwipe.identifier);
      if (!touch) return;

      const deltaX = touch.clientX - activeSwipe.startX;
      const deltaY = touch.clientY - activeSwipe.startY;
      if (!activeSwipe.tracking) {
        const movement = resolveMobileSidebarSwipeMovement(activeSwipe.mode, deltaX, deltaY);
        if (movement === 'cancelled') {
          resetWithoutAnimation();
          return;
        }
        if (movement !== 'tracking') return;
        activeSwipe.tracking = true;
        suppressNextClick();
      }

      event.preventDefault();
      const distance = getMobileSidebarSwipeDistance(activeSwipe.mode, deltaX);
      setTranslateX(getMobileSidebarSwipeTranslateX(activeSwipe.mode, activeSwipe.panelWidth, distance));
    };

    const finishSwipe = (event: TouchEvent) => {
      const activeSwipe = activeSwipeRef.current;
      if (!activeSwipe) return;
      const touch = Array.from(event.changedTouches).find((candidate) => candidate.identifier === activeSwipe.identifier);
      if (!touch || !activeSwipe.tracking) {
        resetWithoutAnimation();
        return;
      }

      const distance = getMobileSidebarSwipeDistance(activeSwipe.mode, touch.clientX - activeSwipe.startX);
      const committed = shouldCommitMobileSidebarSwipe(distance, performance.now() - activeSwipe.startedAt);
      const nextOpen = activeSwipe.mode === 'open' ? committed : !committed;
      clearSwipe(nextOpen);
    };

    const cancelSwipe = () => {
      if (activeSwipeRef.current?.tracking) clearSwipe(sidebarOpen);
      else resetWithoutAnimation();
    };

    const handleClickCapture = (event: MouseEvent) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    };

    document.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
    document.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false });
    document.addEventListener('touchend', finishSwipe, { capture: true, passive: true });
    document.addEventListener('touchcancel', cancelSwipe, { capture: true, passive: true });
    document.addEventListener('click', handleClickCapture, true);
    return () => {
      document.removeEventListener('touchstart', handleTouchStart, true);
      document.removeEventListener('touchmove', handleTouchMove, true);
      document.removeEventListener('touchend', finishSwipe, true);
      document.removeEventListener('touchcancel', cancelSwipe, true);
      document.removeEventListener('click', handleClickCapture, true);
      activeSwipeRef.current = null;
    };
  }, [blocked, clearSwipe, enabled, sidebarOpen]);

  useEffect(() => () => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    if (suppressClickTimerRef.current !== null) window.clearTimeout(suppressClickTimerRef.current);
  }, []);

  const swipeActive = translateX !== null;
  const panelWidth = sidebarRef.current?.getBoundingClientRect().width ?? 0;
  const backdropOpacity = swipeActive && panelWidth > 0
    ? Math.min(1, Math.max(0, 1 + translateX / panelWidth))
    : undefined;

  return { sidebarRef, translateX, swipeActive, backdropOpacity };
}
