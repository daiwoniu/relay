import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import WorkspaceFilePreview from './WorkspaceFilePreview';
import { useChatStore } from '../../stores/chat';
import { useServiceStatus } from '../../hooks/useServiceStatus';
import { isDesktopSidebarViewport, resolveSidebarOpenAfterViewportChange } from '../../utils/sidebar-responsive';
import ThemeBackdrop from '../theme/ThemeBackdrop';
import type { ComposerFocusHandler, ComposerFocusOutletContext, ComposerFocusReason, ComposerFocusRequest } from '../chat/composer-focus';

export default function Layout() {
  const sidebarOpen = useChatStore(state => state.sidebarOpen);
  const setSidebarOpen = useChatStore(state => state.setSidebarOpen);
  const mainRef = useRef<HTMLDivElement>(null);
  const desktopViewportRef = useRef(typeof window === 'undefined' ? true : isDesktopSidebarViewport(window.innerWidth));
  const composerFocusRequestIdRef = useRef(0);
  const composerFocusHandlerRef = useRef<ComposerFocusHandler | null>(null);
  const [composerFocusRequest, setComposerFocusRequest] = useState<ComposerFocusRequest | null>(null);

  const requestComposerFocus = useCallback((reason: ComposerFocusReason) => {
    composerFocusRequestIdRef.current += 1;
    const request: ComposerFocusRequest = {
      id: composerFocusRequestIdRef.current,
      reason,
      sourceElement: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };
    if (composerFocusHandlerRef.current?.(request)) return;
    setComposerFocusRequest(request);
  }, []);
  const registerComposerFocusHandler = useCallback((handler: ComposerFocusHandler) => {
    composerFocusHandlerRef.current = handler;
    return () => {
      if (composerFocusHandlerRef.current === handler) composerFocusHandlerRef.current = null;
    };
  }, []);
  const outletContext = useMemo<ComposerFocusOutletContext>(() => ({
    composerFocusRequest,
    requestComposerFocus,
    registerComposerFocusHandler,
  }), [composerFocusRequest, registerComposerFocusHandler, requestComposerFocus]);

  const serviceStatus = useServiceStatus();

  // 只有跨越 lg 断点时才切换侧边栏，保留同一布局内的用户手动开关状态。
  useEffect(() => {
    const handleResize = () => {
      const nextDesktop = isDesktopSidebarViewport(window.innerWidth);
      const nextOpen = resolveSidebarOpenAfterViewportChange(desktopViewportRef.current, nextDesktop, sidebarOpen);
      desktopViewportRef.current = nextDesktop;
      if (nextOpen !== sidebarOpen) setSidebarOpen(nextOpen);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [sidebarOpen, setSidebarOpen]);

  return (
    <div className="relative isolate flex h-full overflow-hidden bg-[var(--color-bg)]">
      <ThemeBackdrop />
      {/* 左侧边栏 */}
      <Sidebar serviceStatus={serviceStatus} onRequestComposerFocus={requestComposerFocus} />

      {/* 主内容区 */}
      <main ref={mainRef} className="theme-surface relative z-10 flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-bg)]">
        <Outlet context={outletContext} />
      </main>

      <WorkspaceFilePreview />
    </div>
  );
}
