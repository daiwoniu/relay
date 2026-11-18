import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useChatStore, type Project, type Session } from '../../stores/chat';
import type { SessionSearchResultDto, SidebarOrderScope } from '../../generated/relay-contracts';
import HoverCard from '../ui/HoverCard';
import IconActionButton from '../ui/IconActionButton';
import Tooltip from '../ui/Tooltip';
import SessionEngineBadge from '../chat/SessionEngineBadge';
import ProjectDetailsContent from './ProjectDetailsContent';
import SessionDetailsContent from './SessionDetailsContent';
import SessionSearchSummary, { SessionSearchTitle } from './SessionSearchSummary';
import ResourceOwnerBadge from './ResourceOwnerBadge';
import { projectSidebarOrderScope } from './sidebar-order';
import { sidebarDragId } from './sidebar-drag';
import { resolveSessionProjectId } from './session-project';
import { getSidebarSessionStatus, getSessionStatusPresentation, getSessionDisplayStage, type DisplayedSessionStatus } from './session-status';
import ExecutionStatusIcon from '../ui/ExecutionStatusIcon';
import { useSessionReadStore } from '../../stores/session-reads';
import { useAuth } from '../../auth/AuthContext';
import { getSearchResultPresentation } from './session-search-view';

function PinIcon({ filled, size = 14 }: { filled: boolean; size?: number }) {
  if (filled) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        <path d="M9.5 1.5v3.5l3 4v2.5H3.5V9l3-4V1.5h3zM7.5 11v4" fill="currentColor"/>
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M9.5 1.5v3.5l3 4v2.5H3.5V9l3-4V1.5h3z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M7.5 11v3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  );
}

export function TopGroup({ title, expanded, onToggle, children }: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const contentId = `sidebar-group-${title === '置顶' ? 'pinned' : 'projects'}`;
  return (
    <div className="sidebar-group mb-2">
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={contentId}
        className="sidebar-group__trigger group flex w-full items-center gap-2 px-3 text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus-ring)]"
      >
        <span className="text-left">{title}</span>
        <svg
          width="12" height="12" viewBox="0 0 12 12" fill="none"
          className={`opacity-60 transition-transform group-hover:opacity-100 group-focus-visible:opacity-100 ${expanded ? '' : '-rotate-90'}`}
          aria-hidden="true"
        >
          <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {expanded && <div id={contentId} className="mt-0.5">{children}</div>}
    </div>
  );
}

function useRenameInputAutoSelect(isRenaming: boolean) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isRenaming) return;
    inputRef.current?.select();
  }, [isRenaming]);

  return inputRef;
}

export function ProjectBlock({ scope, project, sessions, sessionCount, activeSessionId, expanded, onToggle, onSelectSession, onProjectMenu, onProjectPin, onProjectNewChat, onSessionMenu, onSessionPin, renamingTarget, renameValue, onRenameChange, onRenameSubmit, onRenameCancel, contextMenuActive, contextMenuSessionId, isMobile, dragDisabled, canOrganize, showOwner, dragging, searchQuery, searchResults }: {
  scope: SidebarOrderScope;
  project: Project;
  sessions: Session[];
  sessionCount: number;
  activeSessionId: string | null;
  expanded: boolean;
  onToggle: () => void;
  onSelectSession: (id: string) => void;
  onProjectMenu: (e: React.MouseEvent, project: Project) => void;
  onProjectPin: (projectId: string) => void;
  onProjectNewChat: (projectId: string) => void;
  onSessionMenu: (e: React.MouseEvent, sessionId: string) => void;
  onSessionPin: (sessionId: string) => void;
  renamingTarget: { type: 'project' | 'session'; id: string } | null;
  renameValue: string;
  onRenameChange: (v: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  contextMenuActive: boolean;
  contextMenuSessionId?: string;
  isMobile: boolean;
  dragDisabled: boolean;
  canOrganize: boolean;
  showOwner: boolean;
  dragging: boolean;
  searchQuery: string;
  searchResults: ReadonlyMap<string, SessionSearchResultDto>;
}) {
  const isRenaming = renamingTarget?.type === 'project' && renamingTarget.id === project.id;
  const renameInputRef = useRenameInputAutoSelect(isRenaming);
  const [rowActive, setRowActive] = useState(false);
  const actionsVisible = isMobile || contextMenuActive || rowActive;
  const metadataHidden = !isMobile && actionsVisible;
  const contentId = `project-sessions-${project.id}`;
  const item = { type: 'project' as const, id: project.id };
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sidebarDragId(item),
    data: { scope, item },
    disabled: dragDisabled || isRenaming,
  });
  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.82 : 1,
    zIndex: isDragging ? 2 : undefined,
  };

  return (
    <div className="sidebar-project relative mb-1">
      <HoverCard
        disabled={isMobile || isRenaming || dragging}
        title="项目详情"
        content={<ProjectDetailsContent project={project} />}
      >
        <div
          ref={setNodeRef}
          style={sortableStyle}
          className={`sidebar-project-row group relative flex items-center ${isDragging ? 'sidebar-resource-row--dragging' : ''}`}
          onMouseEnter={() => { if (!isMobile) setRowActive(true); }}
          onMouseLeave={() => { if (!contextMenuActive) setRowActive(false); }}
          onFocusCapture={() => setRowActive(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !contextMenuActive) setRowActive(false);
          }}
        >
          <div className="min-w-0 flex-1">
            {isRenaming ? (
              <div className="flex w-full items-center gap-2 px-3 py-1.5 text-sm">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true">
                <path d="M2 4a1 1 0 011-1h3l2 2h5a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
              </svg>
              <input
                ref={renameInputRef}
                type="text"
                value={renameValue}
                onChange={(event) => onRenameChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onRenameSubmit();
                  if (event.key === 'Escape') onRenameCancel();
                }}
                onBlur={onRenameCancel}
                enterKeyHint="done"
                autoFocus
                data-overlay-ignore
                data-no-drag
                className="sidebar-resource-rename min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-1 py-0 text-sm text-[var(--color-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
              />
              {showOwner && <ResourceOwnerBadge owner={project.owner} />}
              </div>
            ) : (
              <button
                ref={setActivatorNodeRef}
                type="button"
                data-no-sidebar-swipe
                onClick={onToggle}
                onContextMenu={(event) => { if (isMobile) event.preventDefault(); }}
                {...(dragDisabled ? {} : attributes)}
                {...(dragDisabled ? {} : listeners)}
                aria-expanded={expanded}
                aria-controls={contentId}
                className={`sidebar-drag-activator sidebar-project-row__trigger flex w-full min-w-0 items-center gap-2 px-3 text-sm text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text)] focus-visible:outline-none ${dragDisabled ? '' : 'cursor-grab active:cursor-grabbing'}`}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true">
                  <path d="M2 4a1 1 0 011-1h3l2 2h5a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                </svg>
                <span className="min-w-0 flex-1 truncate text-left font-medium">{project.name}</span>
                <span
                  className={`sidebar-project-row__count transition-opacity ${metadataHidden ? 'opacity-0' : 'opacity-100'}`}
                  aria-label={`${sessionCount} 个会话`}
                >
                  {sessionCount}
                </span>
                {showOwner && <ResourceOwnerBadge owner={project.owner} />}
              </button>
            )}
          </div>
          <div
            data-overlay-ignore
            className={`sidebar-resource-actions sidebar-resource-actions--overlay flex shrink-0 items-center transition-opacity ${actionsVisible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}
          >
          {canOrganize && <span className="hidden lg:inline-flex">
            <IconActionButton
              label={project.pinned ? '取消置顶' : '置顶'}
              className="sidebar-resource-action-hitbox w-6 rounded-md"
              tabIndex={actionsVisible ? 0 : -1}
              onClick={(event) => { event.stopPropagation(); onProjectPin(project.id); }}
            >
              <PinIcon filled={!!project.pinned} />
            </IconActionButton>
          </span>}
          {canOrganize && project.access_role !== 'viewer' && <span className="inline-flex">
            <IconActionButton
              label="新会话"
              className="sidebar-resource-action-hitbox w-6 rounded-md"
              tabIndex={actionsVisible ? 0 : -1}
              onClick={(event) => { event.stopPropagation(); onProjectNewChat(project.id); }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </IconActionButton>
          </span>}
          <IconActionButton
            label="更多"
            tooltip={!isMobile}
            className="sidebar-resource-action-hitbox w-6 rounded-md"
            tabIndex={actionsVisible ? 0 : -1}
            onClick={(event) => onProjectMenu(event, project)}
          >
            <MoreIcon />
          </IconActionButton>
          </div>
        </div>
      </HoverCard>

      {expanded && (
        <div id={contentId} className="mt-0.5 space-y-0.5 pl-[22px]">
          {sessions.length === 0 ? (
            <span className="sidebar-navigation-state sidebar-navigation-state--inline block">暂无会话，可使用项目行的“新会话”按钮创建</span>
          ) : (
            <SortableContext items={sessions.map((session) => sidebarDragId({ type: 'session', id: session.id }))} strategy={verticalListSortingStrategy}>
            {sessions.map((s) => (
              <SessionRow
                key={s.id}
                scope={projectSidebarOrderScope(project.id)}
                session={s}
                active={activeSessionId === s.id}
                onSelect={() => onSelectSession(s.id)}
                onMenu={(e) => onSessionMenu(e, s.id)}
                onPin={() => onSessionPin(s.id)}
                renamingTarget={renamingTarget}
                renameValue={renameValue}
                onRenameChange={onRenameChange}
                onRenameSubmit={onRenameSubmit}
                onRenameCancel={onRenameCancel}
                contextMenuActive={contextMenuSessionId === s.id}
                isMobile={isMobile}
                dragDisabled={dragDisabled}
                canOrganize={canOrganize}
                showOwner={showOwner}
                dragging={dragging}
                searchQuery={searchQuery}
                searchResult={searchResults.get(s.id)}
              />
            ))}
            </SortableContext>
          )}
        </div>
      )}
    </div>
  );
}

function MoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="3.5" r="1.2"/>
      <circle cx="8" cy="8" r="1.2"/>
      <circle cx="8" cy="12.5" r="1.2"/>
    </svg>
  );
}

export function SessionRow({ scope, session, active, onSelect, onMenu, renamingTarget, renameValue, onRenameChange, onRenameSubmit, onRenameCancel, contextMenuActive, isMobile, dragDisabled, showOwner, dragging, searchQuery = '', searchResult }: {
  scope: SidebarOrderScope;
  session: Session;
  active: boolean;
  onSelect: () => void;
  onMenu: (e: React.MouseEvent) => void;
  onPin: () => void;
  renamingTarget: { type: 'project' | 'session'; id: string } | null;
  renameValue: string;
  onRenameChange: (v: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  contextMenuActive: boolean;
  isMobile: boolean;
  dragDisabled: boolean;
  canOrganize: boolean;
  showOwner: boolean;
  dragging: boolean;
  searchQuery?: string;
  searchResult?: SessionSearchResultDto;
}) {
  const isRenaming = renamingTarget?.type === 'session' && renamingTarget.id === session.id;
  const renameInputRef = useRenameInputAutoSelect(isRenaming);
  const [rowHovered, setRowHovered] = useState(false);
  const [rowFocused, setRowFocused] = useState(false);
  const projects = useChatStore((s) => s.projects);
  const resolvedProjectId = resolveSessionProjectId(session, projects);
  const project = resolvedProjectId ? projects.find((p) => p.id === resolvedProjectId) ?? null : null;
  const { user } = useAuth();
  const readMessageId = useSessionReadStore((state) => state.receipts[session.id]);
  const displayedStatus = getSidebarSessionStatus(session, readMessageId);
  const statusPresentation = getSessionStatusPresentation(displayedStatus, session.pending_action_kind, session.owner?.id === user?.id, getSessionDisplayStage(session));
  const hasVisibleStatus = statusPresentation.tone !== 'none';
  useLayoutEffect(() => {
    setRowHovered(false);
    setRowFocused(false);
  }, [dragging, isRenaming]);

  const actionsVisible = !dragging && !isRenaming && (isMobile || contextMenuActive || rowHovered || rowFocused);
  const searchPresentation = searchResult
    ? getSearchResultPresentation(searchResult)
    : null;
  const item = { type: 'session' as const, id: session.id };
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sidebarDragId(item),
    data: { scope, item },
    disabled: dragDisabled || isRenaming,
  });
  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.82 : 1,
    zIndex: isDragging ? 2 : undefined,
  };

  return (
    <HoverCard
      disabled={isMobile || isRenaming || dragging}
      title="会话详情"
      maxWidth="min(26rem, calc(100vw - 1rem))"
      content={<SessionDetailsContent session={session} project={project} status={session.status} />}
    >
      <div
        ref={setNodeRef}
        style={sortableStyle}
        onMouseEnter={() => { if (!isMobile && !dragging && !isRenaming) setRowHovered(true); }}
        onMouseLeave={() => {
          setRowHovered(false);
        }}
        onFocusCapture={() => { if (!dragging && !isRenaming) setRowFocused(true); }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRowFocused(false);
        }}
        className={`sidebar-session-row group relative flex items-center gap-0 rounded-lg text-sm transition-colors ${isDragging ? 'sidebar-resource-row--dragging ' : ''}${active
          ? 'sidebar-session-row--active bg-[var(--color-sidebar-active)] text-[var(--color-text)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-hover)] hover:text-[var(--color-text)]'}`}
      >
        {isRenaming ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-2">
            <input
              ref={renameInputRef}
              type="text"
              value={renameValue}
              onChange={(event) => onRenameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onRenameSubmit();
                if (event.key === 'Escape') onRenameCancel();
              }}
              onBlur={onRenameCancel}
              enterKeyHint="done"
              autoFocus
              data-overlay-ignore
              data-no-drag
              onClick={(event) => event.stopPropagation()}
              className="sidebar-resource-rename min-h-10 min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] pl-4 pr-2 text-sm text-[var(--color-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
            />
            {showOwner && <ResourceOwnerBadge owner={session.owner} />}
          </div>
        ) : (
          <button
            type="button"
            data-no-sidebar-swipe
            {...(dragDisabled ? {} : attributes)}
            {...(dragDisabled ? {} : listeners)}
            aria-current={active ? 'page' : undefined}
            aria-label={`打开会话：${session.title}${showOwner && session.owner ? `，所属用户：${session.owner.displayName}` : ''}`}
            onClick={onSelect}
            className={`sidebar-drag-activator sidebar-session-row__trigger flex min-w-0 flex-1 flex-col justify-center rounded-md pl-3 pr-2 text-left focus-visible:outline-none ${dragDisabled ? '' : 'cursor-grab active:cursor-grabbing'}`}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              {session.engine && <SessionEngineBadge engine={session.engine} />}
              <span className="min-w-0 truncate">
              <SessionSearchTitle
                title={session.title}
                query={searchQuery}
                matched={searchResult?.titleMatched ?? false}
              />
              </span>
              {showOwner && <ResourceOwnerBadge owner={session.owner} />}
            </div>
            {searchPresentation?.showSummary && searchPresentation.countLabel && searchPresentation.snippet && (
              <SessionSearchSummary
                countLabel={searchPresentation.countLabel}
                snippet={searchPresentation.snippet}
                query={searchQuery}
              />
            )}
          </button>
        )}
        <div data-overlay-ignore data-session-controls data-has-indicators={hasVisibleStatus || session.codex_archived ? true : undefined} className="sidebar-session-row__tail ml-auto flex shrink-0 items-center gap-1">
          {hasVisibleStatus && (
            <div className="sidebar-resource-status inline-flex items-center justify-center">
              <Tooltip content={statusPresentation.label}>
                <button type="button" onClick={onSelect} aria-label={`打开会话：${statusPresentation.label}`} className="sidebar-session-status-hitbox inline-flex h-7 w-5 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]">
                  <SessionStatusIcon status={displayedStatus} />
                </button>
              </Tooltip>
            </div>
          )}
          {session.codex_archived && <span aria-label="已归档" className="inline-flex w-5 items-center justify-center text-[var(--color-text-tertiary)]"><svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"><path d="M2 2h12v3H2zM3 5v9h10V5M6 8h4" /></svg></span>}
          <div className={`sidebar-resource-actions sidebar-session-actions flex items-center transition-opacity ${actionsVisible ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`}>
            <IconActionButton
              label="更多"
              tooltip={!isMobile}
              className="sidebar-resource-action-hitbox w-6 rounded-md"
              tabIndex={actionsVisible ? 0 : -1}
              onClick={onMenu}
            >
              <MoreIcon />
            </IconActionButton>
          </div>
        </div>
      </div>
    </HoverCard>
  );
}

function SessionStatusIcon({ status }: { status: DisplayedSessionStatus }) {
  return <ExecutionStatusIcon status={status} />;
}
