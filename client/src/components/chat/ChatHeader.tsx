import { useEffect, useRef, type ReactNode } from 'react';
import type { Session } from '../../stores/chat';
import type { RegionLoadState } from '../../stores/region-load-state';
import HoverCard from '../ui/HoverCard';
import IconActionButton from '../ui/IconActionButton';
import { getChatHeaderTitlePresentation } from './chat-header-state';
import SessionEngineBadge from './SessionEngineBadge';

interface Props {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  currentSearchOpen: boolean;
  activeSessionId: string | null;
  currentSession?: Session;
  sessionDetails?: ReactNode;
  titleLoadState?: RegionLoadState;
  onRetryTitle: () => void;
  isMobile: boolean;
  renaming: boolean;
  renameValue: string;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  titleMenuOpen: boolean;
  onToggleTitleMenu: (anchor: DOMRect | null) => void;
  searchOverlay?: ReactNode;
  searchTrigger?: ReactNode;
  wideLayout: boolean;
  onToggleWideLayout: () => void;
  panelVisible: boolean;
  onToggleRightPanel: () => void;
}

export default function ChatHeader({
  sidebarOpen,
  onToggleSidebar,
  currentSearchOpen,
  activeSessionId,
  currentSession,
  sessionDetails,
  titleLoadState,
  onRetryTitle,
  isMobile,
  renaming,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  titleMenuOpen,
  onToggleTitleMenu,
  searchOverlay,
  searchTrigger,
  wideLayout,
  onToggleWideLayout,
  panelVisible,
  onToggleRightPanel,
}: Props) {
  const presentation = getChatHeaderTitlePresentation(activeSessionId, currentSession, titleLoadState);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!renaming) return;
    renameInputRef.current?.select();
  }, [renaming]);

  return (
    <header className="workspace-header theme-region-section">
      <div className="workspace-header__identity">
        {!sidebarOpen && !currentSearchOpen && (
          <IconActionButton label="展开侧边栏" variant="neutral" tooltipPlacement="bottom" onClick={onToggleSidebar} className="h-7 w-7">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
            </svg>
          </IconActionButton>
        )}
        {!currentSearchOpen && presentation === 'ready' && currentSession ? (
          <HoverCard
            disabled={isMobile || renaming}
            placement="bottom"
            title="会话详情"
            maxWidth="min(26rem, calc(100vw - 1rem))"
            content={sessionDetails}
          >
            <div className="workspace-header__title-group">
              {renaming ? (
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameValue}
                  onChange={(event) => onRenameChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onRenameSubmit();
                    if (event.key === 'Escape') onRenameCancel();
                  }}
                  onBlur={onRenameSubmit}
                  enterKeyHint="done"
                  autoFocus
                  data-overlay-ignore
                  className="workspace-header__rename"
                />
              ) : (
                <>{currentSession.engine && <SessionEngineBadge engine={currentSession.engine} />}<h1 className="workspace-header__title">{currentSession.title || '新对话'}</h1></>
              )}
              {!renaming && (
                <IconActionButton
                  label="更多操作"
                  variant="neutral"
                  tooltipPlacement="bottom"
                  tooltip={!isMobile}
                  className="h-6 w-6"
                  aria-expanded={titleMenuOpen}
                  onClick={(event) => onToggleTitleMenu(titleMenuOpen ? null : event.currentTarget.getBoundingClientRect())}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={`transition-transform ${titleMenuOpen ? 'rotate-180' : ''}`}>
                    <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </IconActionButton>
              )}
            </div>
          </HoverCard>
        ) : !currentSearchOpen && presentation === 'loading' ? (
          <div className="workspace-header__title-loading" role="status" aria-label="正在加载会话标题" />
        ) : !currentSearchOpen && presentation === 'error' ? (
          <div className="workspace-header__title-error">
            <span className="truncate">会话信息加载失败</span>
            <button type="button" onClick={onRetryTitle} className="workspace-header__retry">重试</button>
          </div>
        ) : !currentSearchOpen ? (
          <h1 className="workspace-header__title-empty">空会话</h1>
        ) : null}
      </div>

      {currentSearchOpen && activeSessionId && searchOverlay}

      <div className="workspace-header__actions">
        {currentSession && !currentSearchOpen && searchTrigger}
        {!isMobile && activeSessionId && !currentSearchOpen && (
          <IconActionButton
            label={wideLayout ? '恢复标准宽度' : '切换宽屏显示'}
            variant="neutral"
            tooltipPlacement="bottom"
            aria-pressed={wideLayout}
            onClick={onToggleWideLayout}
            className={wideLayout ? 'workspace-header__action is-pressed' : 'workspace-header__action'}
          >
            {wideLayout ? (
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2.5 3.25v9.5M13.5 3.25v9.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
                <path d="M4.25 8h3M7.25 8L5.5 6.25M7.25 8L5.5 9.75M11.75 8h-3M8.75 8l1.75-1.75M8.75 8l1.75 1.75" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2.5 3.25v9.5M13.5 3.25v9.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
                <path d="M7.25 8h-3M4.25 8L6 6.25M4.25 8L6 9.75M8.75 8h3M11.75 8L10 6.25M11.75 8L10 9.75" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </IconActionButton>
        )}
        {activeSessionId && !currentSearchOpen && (
          <IconActionButton label={panelVisible ? '关闭预览面板' : '展开预览面板'} variant="neutral" tooltipPlacement="bottom" aria-pressed={panelVisible} className={panelVisible ? 'workspace-header__action is-pressed' : 'workspace-header__action'} onClick={onToggleRightPanel}>
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 2.5h5l3 3v8H4v-11z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
              <path d="M9 2.5v3h3" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
              <path d="M5.5 9.5S6.45 8 8 8s2.5 1.5 2.5 1.5S9.55 11 8 11 5.5 9.5 5.5 9.5z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="8" cy="9.5" r="0.75" fill="currentColor" />
            </svg>
          </IconActionButton>
        )}
      </div>
    </header>
  );
}
