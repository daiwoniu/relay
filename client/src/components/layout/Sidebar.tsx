import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { flushSync } from 'react-dom';
import { DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors,
  type CollisionDetection, type DragCancelEvent, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useChatStore, type Project, type Session } from '../../stores/chat';
import { getDisplayedSessionStatus } from './session-status';
import { useAuth } from '../../auth/AuthContext';
import { deleteProject, getProjectDeletionImpact, updateProject } from '../../api/projects';
import { deleteSession, forkSession, getSession, getSessionDeletionImpact, searchSessionMessages, searchSessions, unarchiveSession, updateSession as updateSessionRequest } from '../../api/sessions';
import { ApiError } from '../../api/client';
import ConfirmDialog from '../ui/ConfirmDialog';
import { ListState } from '../ui/ListControls';
import CreateSessionFromContextDialog from '../chat/CreateSessionFromContextDialog';
import { isSessionActionInProgress } from '../chat/session-action-state';
import { getSessionDeletePendingLabel } from '../chat/session-delete-progress';
import { useSessionDeletionProgressStore } from '../../stores/session-deletion-progress';
import Tooltip from '../ui/Tooltip';
import ContextMenuPopup, { type ContextMenuItem } from '../ui/ContextMenu';
import type { ServiceStatus } from '../ui/ServiceStatusIndicator';
import { useOverlay } from '../ui/OverlayProvider';
import { resolveDefaultProjectId, resolveSessionProjectId, readShowAllProjectsPreference, storeShowAllProjectsPreference } from './session-project';
import {featureAction,localAction} from '../../analytics/features';
import { copyToClipboard } from '../../utils/clipboard';
import type { EngineId, EngineStatusDto, ProjectDeletionImpactDto, PublicUserDto, SessionDeletionImpactDto, SessionSearchResultDto } from '../../generated/relay-contracts';
import { getEngineStatuses } from '../../api/system';
import { listSidebarOrders, moveSidebarItem } from '../../api/sidebar-order';
import { resolveSidebarItems } from './sidebar-order';
import { createSidebarDropMove, isMatchingSidebarDropTarget, isSidebarDragData, sidebarDragId } from './sidebar-drag';
import { truncateMiddlePath } from '../../utils/path-display';
import { createSessionMenuItems } from '../chat/session-menu-items';
import { MenuIcon } from '../icons/MenuIcon';
import { readStoredChatLocation, readUrlSessionChatLocation, readUrlWorkspaceTaskProjectLocation, resolveInitialChatLocation, retainPendingUrlSessionLocation } from '../../stores/chat-location';
import { loadSidebarNavigation } from './sidebar-navigation-loader';
import MySharesDialog from '../sharing/MySharesDialog';
import ShareCreateDialog, { type ShareDraft } from '../sharing/ShareCreateDialog';
import ServiceMaintenanceDialog from '../system/ServiceMaintenanceDialog';
import EngineMaintenanceDialog from '../system/EngineMaintenanceDialog';
import DetailsDialog from './DetailsDialog';
import ProjectDetailsContent from './ProjectDetailsContent';
import SessionDetailsContent from './SessionDetailsContent';
import SettingsCenterDialog from '../settings/SettingsCenterDialog';
import AccountManagementDialog from '../account/AccountManagementDialog';
import { expandSidebarProjectGroup, isSidebarGroupExpanded, toggleSidebarGroup } from './sidebar-group-state';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  readStoredSidebarWidth,
  storeSidebarWidth,
} from './sidebar-width';
import { useSessionSearchStore } from '../../stores/session-search';
import UserMenu from './UserMenu';
import AdministrationCenter, { type AdministrationPanel } from './AdministrationCenter';
import { PanelReturnContext } from '../ui/PanelShell';
import UserResourceDialog, { type UserResourceSelection } from './UserResourceDialog';
import SidebarWorkbench from './SidebarWorkbench';
import ProjectUploadsDialog from '../projects/ProjectUploadsDialog';
import ProjectMembersDialog from '../projects/ProjectMembersDialog';
import TrashDialog from '../trash/TrashDialog';
import { restoreMinimizedPanel } from '../ui/minimizedPanelRegistry';
import {
  getFallbackTitleMatches,
  SIDEBAR_SEARCH_DEBOUNCE_MS,
} from './session-search-view';
import SidebarLoadingState from './SidebarLoadingState';
import { ProjectBlock, SessionRow, TopGroup } from './SidebarNavigationItems';
import { getSidebarNavigation } from './sidebar-navigation';
import type { ComposerFocusReason } from '../chat/composer-focus';
import useMobileSidebarSwipe from './useMobileSidebarSwipe';

import { getSidebarOwnerFilter, resolveSidebarOwnerId } from './sidebar-account-filter';
import { canCreateSidebarProjectSession, getSidebarAccountInteractionPolicy } from './sidebar-account-interactions';
import { getMobileSidebarTranslateClass } from './mobile-sidebar-swipe';
import { getProjectDeleteMenuState, type ProjectDeletionImpactState } from './project-delete-state';
// 上下文菜单类型
interface ContextMenu {
  type: 'project' | 'session';
  projectId?: string;
  sessionId?: string;
  anchorRect: DOMRect;
}
const PageHostingPanel = lazy(() => import('../page-hosting/PageHostingPage'));

function openSidebarPanel(panelId: string, setOpen: (value: boolean) => void) {
  if (!restoreMinimizedPanel(panelId)) setOpen(true);
}

export default function Sidebar({
  serviceStatus = 'checking',
  onRequestComposerFocus,
}: {
  serviceStatus?: ServiceStatus;
  onRequestComposerFocus: (reason: ComposerFocusReason) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const isWorkspaceConsole = location.pathname === '/admin/task-workbench';
  const { user, logout } = useAuth();
  const [ownerFilterId, setOwnerFilterId] = useState<string | null>(null);
  const {
    sessions,
    activeSessionId,
    sidebarOpen,
    panelVisible,
    sidebarAccountScope: accountScope,
    setSidebarAccountScope: setAccountScope,
    setSessions,
    addSession,
    ensureSession,
    setActiveSession,
    navigationLoadState,
    beginNavigationLoad,
    completeNavigationLoad,
    failNavigationLoad,
    setSidebarOpen,
    projects,
    setProjects,
    setCurrentProject,
    currentProjectId,
    pendingProjectPath,
    setPendingProject,
    autoOpenProjectPicker,
    projectSelectionLocked,
    removeProject,
    updateProjectName,
    updateProjectPinned,
    setSidebarOrders,
    setSidebarOrder,
    sidebarOrders,
    updateSessionPinned,
    updateSessionTitle,
    updateSession,
    removeSession,
  } = useChatStore();
  const { closeAllOverlays, closeOverlay, openOverlay } = useOverlay();
  const searchQuery = useSessionSearchStore((state) => state.query);
  const searchStatus = useSessionSearchStore((state) => state.status);
  const searchResults = useSessionSearchStore((state) => state.results);
  const beginSearch = useSessionSearchStore((state) => state.beginSearch);
  const applySearchResults = useSessionSearchStore((state) => state.applySearchResults);
  const failSearch = useSessionSearchStore((state) => state.failSearch);
  const setSessionMatches = useSessionSearchStore((state) => state.setSessionMatches);
  const clearSessionMatches = useSessionSearchStore((state) => state.clearSessionMatches);
  const clearSearch = useSessionSearchStore((state) => state.clearSearch);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [engineStatuses, setEngineStatuses] = useState<EngineStatusDto[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [projectMenuDeletionImpact, setProjectMenuDeletionImpact] = useState<ProjectDeletionImpactState | null>(null);
  const [forkingSessionId, setForkingSessionId] = useState<string | null>(null);
  const [createSessionTarget, setCreateSessionTarget] = useState<Session | null>(null);
  const [renamingTarget, setRenamingTarget] = useState<{ type: 'project' | 'session'; id: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<
    | { type: 'project'; project: Project; impact: ProjectDeletionImpactDto | null; impactStatus: 'loading' | 'ready' | 'unavailable' }
    | { type: 'session'; session: Session; impact: SessionDeletionImpactDto | null; impactStatus: 'loading' | 'ready' | 'unavailable' }
    | null
  >(null);
  const deleteProgressStage = useSessionDeletionProgressStore((state) => deleteConfirm?.type === 'session'
    ? state.bySessionId[deleteConfirm.session.id] ?? null
    : null);
  const clearDeleteProgressStage = useSessionDeletionProgressStore((state) => state.clearStage);
  const [userMenuAnchor, setUserMenuAnchor] = useState<DOMRect | null>(null);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [mySharesOpen, setMySharesOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [shareDraft, setShareDraft] = useState<ShareDraft | null>(null);
  const [serviceMaintenanceOpen, setServiceMaintenanceOpen] = useState(false);
  const [engineMaintenanceOpen, setEngineMaintenanceOpen] = useState(false);
  const [requestedMaintenanceEngine, setRequestedMaintenanceEngine] = useState<{ engineId: EngineId } | null>(null);
  const [administrationOpen, setAdministrationOpen] = useState(false);
  const [administrationOrigins, setAdministrationOrigins] = useState<Partial<Record<AdministrationPanel, boolean>>>({});
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [accountManagementOpen, setAccountManagementOpen] = useState(false);
  const [pageHostingOpen, setPageHostingOpen] = useState(false);
  const [hostingRequest, setHostingRequest] = useState<{path:string;requestId:number}|null>(null);
  const [userResourceDialogOpen, setUserResourceDialogOpen] = useState(false);
  const [selectedResourceUser, setSelectedResourceUser] = useState<PublicUserDto | null>(null);
  const [uploadsProjects, setUploadsProjects] = useState<Project[]>([]);
  const [membersProjects, setMembersProjects] = useState<Project[]>([]);
  const [mobileDetails, setMobileDetails] = useState<
    | { type: 'project'; project: Project }
    | { type: 'session'; session: Session & { engine_session_id?: string | null }; engineSessionLoadFailed?: boolean }
    | null
  >(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [navigationReloadVersion, setNavigationReloadVersion] = useState(0);
  const suppressClickRef = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(SIDEBAR_DEFAULT_WIDTH);
  const sidebarWidthRef = useRef(sidebarWidth);
  const urlSessionLocationRef = useRef(readUrlSessionChatLocation());
  const personalLocationRef = useRef<{ sessionId: string | null; projectId: string | null; pendingProjectPath: string | null; autoOpenProjectPicker: boolean; projectSelectionLocked: boolean } | null>(null);
  // 移动端检测：< 1024px
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1024);
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 7 } });
  const touchSensor = useSensor(TouchSensor, { activationConstraint: { delay: 280, tolerance: 8 } });
  const keyboardSensor = useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates });
  const desktopSensors = useSensors(pointerSensor, keyboardSensor);
  const mobileSensors = useSensors(touchSensor, keyboardSensor);
  const sensors = isMobile ? mobileSensors : desktopSensors;
  const sidebarSwipe = useMobileSidebarSwipe({
    enabled: isMobile,
    sidebarOpen,
    blocked: panelVisible || activeDragId !== null,
    onOpenChange: setSidebarOpen,
  });
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 1024);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const openSessionDetails = useCallback((session: Session) => {
    setMobileDetails({ type: 'session', session });
    void getSession(session.id)
      .then((details) => setMobileDetails((current) => current?.type === 'session' && current.session.id === session.id
        ? { type: 'session', session: details }
        : current))
      .catch(() => setMobileDetails((current) => current?.type === 'session' && current.session.id === session.id
        ? { type: 'session', session, engineSessionLoadFailed: true }
        : current));
  }, []);
  useEffect(() => {
    let cancelled = false;
    void getEngineStatuses()
      .then((value) => { if (!cancelled) setEngineStatuses(value.engines); })
      .catch(() => { if (!cancelled) setEngineStatuses([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  const handleResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    closeAllOverlays();
    event.currentTarget.focus({ preventScroll: true });
    openOverlay('dragging', 'sidebar-resize');
    resizeStartX.current = event.clientX;
    resizeStartWidth.current = sidebarWidth;
    setIsResizing(true);
  }, [closeAllOverlays, openOverlay, sidebarWidth]);

  const updateSidebarWidth = useCallback((width: number, persist = false) => {
    const nextWidth = clampSidebarWidth(width);
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
    if (persist) storeSidebarWidth(nextWidth);
  }, []);

  const handleResizeKeyDown = useCallback((event: React.KeyboardEvent) => {
    let nextWidth: number | null = null;
    if (event.key === 'ArrowLeft') nextWidth = sidebarWidth - 10;
    if (event.key === 'ArrowRight') nextWidth = sidebarWidth + 10;
    if (event.key === 'Home') nextWidth = SIDEBAR_MIN_WIDTH;
    if (event.key === 'End') nextWidth = SIDEBAR_MAX_WIDTH;
    if (nextWidth === null) return;if(nextWidth!==sidebarWidth)featureAction('layout','resize','keyboard');
    event.preventDefault();
    updateSidebarWidth(nextWidth, true);
  }, [sidebarWidth, updateSidebarWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const handleMouseMove = (event: MouseEvent) => {
      updateSidebarWidth(resizeStartWidth.current + event.clientX - resizeStartX.current);
    };
    const handleMouseUp = () => {
      if(sidebarWidthRef.current!==resizeStartWidth.current)featureAction('layout','resize','sidebar');storeSidebarWidth(sidebarWidthRef.current);
      setIsResizing(false);
      closeOverlay('dragging', 'sidebar-resize');
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      closeOverlay('dragging', 'sidebar-resize');
    };
  }, [closeOverlay, isResizing, updateSidebarWidth]);

  // 加载数据
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const generation = beginNavigationLoad();
    const candidateAtStart = useChatStore.getState().activeSessionId;
    const openVersionAtStart = useChatStore.getState().activeSessionOpenVersion;
    const pendingRestoreSessionId = useChatStore.getState().pendingRestoreSessionId;
    const storedLocation = readUrlWorkspaceTaskProjectLocation() ?? readStoredChatLocation();
    const urlSessionLocation = retainPendingUrlSessionLocation(urlSessionLocationRef.current, pendingRestoreSessionId ?? candidateAtStart);
    urlSessionLocationRef.current = urlSessionLocation;
    const restoreSessionLocation = urlSessionLocation ?? (pendingRestoreSessionId
      ? { version: 1 as const, kind: 'session' as const, sessionId: pendingRestoreSessionId }
      : null);
    void listSidebarOrders(controller.signal)
      .then((response) => {
        if (!cancelled && useChatStore.getState().navigationLoadState.generation === generation) {
          setSidebarOrders(response.orders);
        }
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') console.warn('[Relay] 侧栏排序加载失败，使用默认顺序:', error);
      });

    loadSidebarNavigation(controller.signal, restoreSessionLocation)
      .then(({ sessions: navigationSessions, projects: projectList }) => {
        if (cancelled || useChatStore.getState().navigationLoadState.generation !== generation) return;
        setSessions(navigationSessions);
        setProjects(projectList);
        urlSessionLocationRef.current = null;
        const currentActiveSessionId = useChatStore.getState().activeSessionId;
        // 加载期间用户已主动打开会话（包括新建空会话），不得用启动位置覆盖。
        if (useChatStore.getState().activeSessionOpenVersion !== openVersionAtStart) {
          completeNavigationLoad(generation);
          return;
        }
        if (currentActiveSessionId !== candidateAtStart) {
          if (currentActiveSessionId) {
            completeNavigationLoad(generation);
            return;
          }
        }
        const restored = resolveInitialChatLocation(
          currentActiveSessionId === candidateAtStart ? urlSessionLocation : null,
          currentActiveSessionId === candidateAtStart ? storedLocation : readStoredChatLocation(),
          navigationSessions,
          projectList,
          user?.defaultProjectId,
        );
        if (restored.activeSessionId) {
          const restoredProjectId = restored.currentProjectId;
          if (restoredProjectId) {
            setExpandedGroups((current) => expandSidebarProjectGroup(current, restoredProjectId));
          }
          if (currentActiveSessionId !== restored.activeSessionId) setActiveSession(restored.activeSessionId);
          if (restored.currentProjectId) setCurrentProject(restored.currentProjectId);
          completeNavigationLoad(generation);
          return;
        }
        if (restored.currentProjectId) setCurrentProject(restored.currentProjectId);
        if (
          currentActiveSessionId
          || pendingRestoreSessionId
          || useChatStore.getState().autoOpenProjectPicker !== restored.autoOpenProjectPicker
          || useChatStore.getState().projectSelectionLocked !== (restored.projectSelectionLocked === true)
        ) {
          setActiveSession('', {
            autoOpenProjectPicker: restored.autoOpenProjectPicker,
            projectSelectionLocked: restored.projectSelectionLocked === true,
          });
        }
        completeNavigationLoad(generation);
      })
      .catch((error) => {
        if (cancelled || error?.name === 'AbortError') return;
        console.error(error);
        failNavigationLoad(generation, error instanceof Error ? error.message : '导航加载失败');
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [beginNavigationLoad, completeNavigationLoad, failNavigationLoad, navigationReloadVersion, setActiveSession, setCurrentProject, setProjects, setSessions, setSidebarOrders, user?.defaultProjectId]);

  const sidebarOwnerId = user?.role === 'admin' ? resolveSidebarOwnerId(user.id, accountScope, ownerFilterId) : null;
  useEffect(() => {
    const normalizedQuery = searchQuery.trim();
    if (!normalizedQuery) return;
    const requestId = useSessionSearchStore.getState().requestId;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchSessions(normalizedQuery, { ownerUserId: sidebarOwnerId, signal: controller.signal })
        .then((response) => {
          if (!controller.signal.aborted) applySearchResults(requestId, response);
        })
        .catch((error) => {
          if (!controller.signal.aborted) failSearch(requestId, error instanceof Error ? error.message : '搜索会话失败');
        });
    }, SIDEBAR_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [applySearchResults, failSearch, searchQuery, sidebarOwnerId]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const closeUserMenu = useCallback(() => setUserMenuAnchor(null), []);
  const administrationPanels = useMemo(() => ({
    accounts: { id: 'account-management-title', open: setAccountManagementOpen, close: () => setAccountManagementOpen(false) },
    pages: { id: 'page-hosting-title', open: setPageHostingOpen, close: () => { setPageHostingOpen(false); setHostingRequest(null); } },
    server: { id: 'service-maintenance-title', open: setServiceMaintenanceOpen, close: () => setServiceMaintenanceOpen(false) },
    engines: { id: 'engine-maintenance-title', open: setEngineMaintenanceOpen, close: () => { setEngineMaintenanceOpen(false); setRequestedMaintenanceEngine(null); } },
  }), []);
  const openAdministrationPanel = useCallback((panel: AdministrationPanel, fromCenter: boolean) => {
    if (!user || ((fromCenter || panel !== 'engines') && user.role !== 'admin')) return;
    closeUserMenu();
    setAdministrationOpen(false);
    setAdministrationOrigins(current => ({ ...current, [panel]: fromCenter }));
    const destination = administrationPanels[panel];
    openSidebarPanel(destination.id, destination.open);
  }, [administrationPanels, closeUserMenu, user]);

  useEffect(() => {
    const openEngineStatus = (event: Event) => {
      const engineId = (event as CustomEvent<{ engineId?: EngineId }>).detail?.engineId;
      if (engineId) setRequestedMaintenanceEngine({ engineId });
      openAdministrationPanel('engines', false);
    };
    const openHosting = (event: Event) => {
      if (user?.role !== 'admin') return;
      const path = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (!path) return;
      setHostingRequest({ path, requestId: Date.now() });
      openAdministrationPanel('pages', false);
    };
    window.addEventListener('relay:open-engine-maintenance', openEngineStatus);
    window.addEventListener('relay:open-page-hosting', openHosting);
    return () => {
      window.removeEventListener('relay:open-engine-maintenance', openEngineStatus);
      window.removeEventListener('relay:open-page-hosting', openHosting);
    };
  }, [openAdministrationPanel, user?.role]);

  const getAdministrationReturn = (id: string) => {
    if (user?.role !== 'admin') return undefined;
    const panel = (Object.keys(administrationPanels) as AdministrationPanel[]).find(key => administrationPanels[key].id === id);
    if (!panel || !administrationOrigins[panel]) return undefined;
    return () => {
      administrationPanels[panel].close();
      setAdministrationOpen(true);
    };
  };
  const closeMobileSidebar = useCallback(() => {
    setSidebarOpen(false);
    setMobileDetails(null);
    closeAllOverlays();
  }, [closeAllOverlays, setSidebarOpen]);

  const handleNewChat = () => {
    clearSearch();
    const defaultProjectId = resolveDefaultProjectId(projects, user?.defaultProjectId);
    if (isMobile) closeMobileSidebar();
    else closeAllOverlays();
    flushSync(() => {
      if (defaultProjectId) setCurrentProject(defaultProjectId);
      setActiveSession('', { autoOpenProjectPicker: !defaultProjectId, projectSelectionLocked: false });
    });
    if (isWorkspaceConsole || location.pathname === '/admin/page-hosting') navigate('/');
    onRequestComposerFocus('new-chat');
  };

  const restorePersonalResourceView = () => {
    clearSearch();
    setAccountScope('mine');
    setOwnerFilterId(null);
    setSelectedResourceUser(null);
    const previous = personalLocationRef.current;
    personalLocationRef.current = null;
    if (!previous) return;
    const previousSession = sessions.find((session) => session.id === previous.sessionId && session.owner?.id === user?.id);
    flushSync(() => {
      if (previousSession) { setActiveSession(previousSession.id); return; }
      if (previous.pendingProjectPath) setPendingProject(previous.pendingProjectPath);
      else if (previous.projectId) setCurrentProject(previous.projectId);
      else setPendingProject(null);
      setActiveSession('', { autoOpenProjectPicker: previous.autoOpenProjectPicker, projectSelectionLocked: previous.projectSelectionLocked });
    });
  };

  const selectUserResourceView = (selection: UserResourceSelection) => {
    if (selection.type === 'mine') {
      restorePersonalResourceView();
      return;
    }
    if (accountScope === 'mine') {
      personalLocationRef.current = { sessionId: activeSessionId, projectId: currentProjectId, pendingProjectPath, autoOpenProjectPicker, projectSelectionLocked };
    }
    clearSearch();
    setAccountScope('all');
    if (selection.type === 'all') {
      setOwnerFilterId(null);
      setSelectedResourceUser(null);
      if (!activeSessionId) {
        flushSync(() => {
          setPendingProject(null);
          setActiveSession('', { autoOpenProjectPicker: false, projectSelectionLocked: true });
        });
      }
      return;
    }
    setOwnerFilterId(selection.user.id);
    setSelectedResourceUser(selection.user);
    const firstSession = sessions.find((session) => session.owner?.id === selection.user.id);
    const firstProject = firstSession
      ? projects.find((project) => project.id === resolveSessionProjectId(firstSession, projects))
      : projects.find((project) => project.owner?.id === selection.user.id);
    flushSync(() => {
      setPendingProject(null);
      if (firstProject) setCurrentProject(firstProject.id);
      setActiveSession('', { autoOpenProjectPicker: false, projectSelectionLocked: true });
    });
  };

  useEffect(() => {
    if (accountScope !== 'mine') return;
    setOwnerFilterId(null);
    setSelectedResourceUser(null);
    personalLocationRef.current = null;
  }, [accountScope]);

  const handleSelectSession = (id: string) => {
    const normalizedQuery = searchQuery.trim();
    const searchResult = resultBySessionId.get(id);if(normalizedQuery&&searchResult)featureAction('session','search_result','sidebar');
    if (searchResult) ensureSession(searchResult.session);
    setActiveSession(id);
    navigate('/');
    if (!normalizedQuery) onRequestComposerFocus('session-opened');
    if (normalizedQuery && searchResult?.messageMatchCount) {
      void searchSessionMessages(id, normalizedQuery)
        .then((response) => {
          const current = useSessionSearchStore.getState();
          if (current.query.trim() === normalizedQuery && useChatStore.getState().activeSessionId === id) {
            setSessionMatches(id, response);
          }
        })
        .catch((error) => useChatStore.getState().setError(
          error instanceof Error ? error.message : '加载匹配消息失败',
          id,
        ));
    } else {
      clearSessionMatches();
    }
    closeAllOverlays();
    if (isMobile) closeMobileSidebar();
  };
  const toggleGroup = (key: string) => {featureAction(key.startsWith('p-')?'project':'layout',isSidebarGroupExpanded(expandedGroups,key)?'collapse':'expand','sidebar');setExpandedGroups((current) => toggleSidebarGroup(current, key));};

  // ---- 项目操作 ----
  const openProjectMenu = (e: React.MouseEvent, project: Project) => {
    e.stopPropagation();
    setContextMenu({ type: 'project', projectId: project.id, anchorRect: e.currentTarget.getBoundingClientRect() });
    setProjectMenuDeletionImpact({ projectId: project.id, status: 'loading', impact: null });
    void getProjectDeletionImpact(project.id)
      .then((impact) => setProjectMenuDeletionImpact((current) => current?.projectId === project.id
        ? { projectId: project.id, status: 'ready', impact }
        : current))
      .catch(() => setProjectMenuDeletionImpact((current) => current?.projectId === project.id
        ? { projectId: project.id, status: 'unavailable', impact: null }
        : current));
  };

  const handleProjectNewChat = (projectId: string) => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project || !canCreateSidebarProjectSession(project, accountInteractionPolicy.canOrganize)) return;
    featureAction('project', 'select', 'sidebar');
    clearSearch();
    flushSync(() => {
      setCurrentProject(projectId);
      setActiveSession('', { autoOpenProjectPicker: false, projectSelectionLocked: false });
    });
    if (isWorkspaceConsole || location.pathname === '/admin/page-hosting') navigate('/');
    onRequestComposerFocus('new-chat');
    setContextMenu(null);
    closeAllOverlays();
    if (isMobile) closeMobileSidebar();
  };

  const handleProjectPin = (projectId: string) => {
    if (accountScope === 'all') return;
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    const newPinned = project.pinned ? 0 : 1;
    void updateProject(projectId, { pinned: newPinned }).then(() => updateProjectPinned(projectId, !!newPinned)).catch(console.error);
    setContextMenu(null);
  };

  const handleProjectRenameStart = (projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    setRenamingTarget({ type: 'project', id: projectId });
    setRenameValue(project.name);
    setContextMenu(null);
  };

  const handleProjectRenameSubmit = () => {
    if (!renamingTarget || renamingTarget.type !== 'project') return;
    const name = renameValue.trim();
    if (name) {
      void updateProject(renamingTarget.id, { name }).then(() => updateProjectName(renamingTarget.id, name)).catch(console.error);
    }
    setRenamingTarget(null);
  };

  const handleProjectDeleteStart = (projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    const menuState = projectMenuDeletionImpact?.projectId === projectId ? projectMenuDeletionImpact : null;
    if (!project) return;
    const deleteState = getProjectDeleteMenuState(menuState, false, Boolean(project.deletion_protected), user?.defaultProjectId === project.id);
    if (deleteState.disabled) {
      useChatStore.getState().setError(deleteState.reason ?? '当前项目无法删除');
      return;
    }
    setDeleteConfirm({ type: 'project', project, impact: null, impactStatus: 'loading' });
    void getProjectDeletionImpact(project.id)
      .then((impact) => {
        if (impact.inProgressSessionCount > 0) {
          setDeleteConfirm(null);
          useChatStore.getState().setError('项目中有会话正在处理中，完成后才能删除');
          return;
        }
        setDeleteConfirm((current) => current?.type === 'project' && current.project.id === project.id
          ? { ...current, impact, impactStatus: 'ready' }
          : current);
      })
      .catch(() => setDeleteConfirm((current) => current?.type === 'project' && current.project.id === project.id
        ? { ...current, impact: null, impactStatus: 'unavailable' }
        : current));
    setContextMenu(null);
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    try {
      if (deleteConfirm.type === 'project' && deleteConfirm.project) {
        const latestImpact = await getProjectDeletionImpact(deleteConfirm.project.id);
        if (latestImpact.inProgressSessionCount > 0) {
          setDeleteConfirm(null);
          useChatStore.getState().setError('项目中有会话正在处理中，完成后才能删除');
          return;
        }
        await deleteProject(deleteConfirm.project.id);
        removeProject(deleteConfirm.project.id);
        if (currentProjectId === deleteConfirm.project.id) {
          const remaining = useChatStore.getState().projects;
          setCurrentProject(remaining.length > 0 ? remaining[0].id : '');
        }
      } else if (deleteConfirm.type === 'session' && deleteConfirm.session) {
        const targetSessionId = deleteConfirm.session.id;
        const latest = useChatStore.getState().sessions.find((session) => session.id === deleteConfirm.session.id);
        if (latest && isSessionActionInProgress(latest.status)) {
          setDeleteConfirm(null);
          useChatStore.getState().setError('会话正在处理中，完成后才能删除', latest.id);
          return;
        }
        await deleteSession(targetSessionId);
        clearDeleteProgressStage(targetSessionId);
        removeSession(targetSessionId);
      }
      setDeleteConfirm(null);
    } catch (error) {
      if (deleteConfirm.type === 'session') clearDeleteProgressStage(deleteConfirm.session.id);
      useChatStore.getState().setError(error instanceof ApiError && error.status === 409
        ? '仍有会话正在处理中，完成后才能删除'
        : error instanceof Error ? error.message : '删除失败');
      setDeleteConfirm(null);
    }
  };

  // ---- 会话操作 ----
  const openSessionMenu = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    setContextMenu({ type: 'session', sessionId, anchorRect: e.currentTarget.getBoundingClientRect() });
  };

  const handleSessionPin = (sessionId: string) => {
    if (accountScope === 'all') return;
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const newPinned = session.pinned ? 0 : 1;
    void updateSessionRequest(sessionId, { pinned: newPinned }).then(() => updateSessionPinned(sessionId, !!newPinned)).catch(console.error);
    setContextMenu(null);
  };

  const handleSessionRenameStart = (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    setRenamingTarget({ type: 'session', id: sessionId });
    setRenameValue(session.title);
    setContextMenu(null);
  };

  const handleSessionRenameSubmit = () => {
    if (!renamingTarget || renamingTarget.type !== 'session') return;
    const title = renameValue.trim();
    if (title) {
      void updateSessionRequest(renamingTarget.id, { title }).then(() => updateSessionTitle(renamingTarget.id, title)).catch(console.error);
    }
    setRenamingTarget(null);
  };

  const handleSessionDeleteStart = (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session || isSessionActionInProgress(session.status)) return;
    clearDeleteProgressStage(session.id);
    setDeleteConfirm({ type: 'session', session, impact: null, impactStatus: 'loading' });
    void getSessionDeletionImpact(session.id)
      .then((impact) => setDeleteConfirm((current) => current?.type === 'session' && current.session.id === session.id
        ? { ...current, impact, impactStatus: 'ready' }
        : current))
      .catch(() => setDeleteConfirm((current) => current?.type === 'session' && current.session.id === session.id
        ? { ...current, impact: null, impactStatus: 'unavailable' }
        : current));
    setContextMenu(null);
  };

  const handleSessionUnarchive = async (sessionId: string) => {
    try {
      const result = await unarchiveSession(sessionId);
      updateSession(result.session);
    } catch (error) {
      useChatStore.getState().setError(
        error instanceof Error ? error.message : '取消归档失败',
        sessionId,
      );
    } finally {
      setContextMenu(null);
    }
  };

  const requestSessionFork = (session: Session) => {
    if (forkingSessionId) return;
    setContextMenu(null);
    setCreateSessionTarget(session);
  };

  const confirmSessionFork = async () => {
    if (!createSessionTarget || forkingSessionId) return;
    const sessionId = createSessionTarget.id;
    setForkingSessionId(sessionId);
    try {
      const result = await forkSession(sessionId);
      addSession(result.session);
      setActiveSession(result.session.id);
      if (isMobile) setSidebarOpen(false);
    } catch (error) {
      useChatStore.getState().setError(error instanceof Error ? error.message : '创建新会话失败', sessionId);
    } finally {
      setForkingSessionId(null);
      setCreateSessionTarget(null);
    }
  };

  const handleSessionShare = (session: Session) => {
    if (shareDraft?.sessionId === session.id && restoreMinimizedPanel('share-create-title')) { setContextMenu(null); return; }
    setShareDraft({
      sessionId: session.id,
      scope: 'session',
      defaultTitle: session.title,
    });
    setContextMenu(null);
  };

  // ---- 数据分类 ----
  // 全部用户视图隐藏没有会话的空项目（可用开关显示全部）；会话归属按完整项目列表解析
  const [showAllProjects, setShowAllProjects] = useState(readShowAllProjectsPreference);
  const toggleShowAllProjects = () => setShowAllProjects((previous) => (storeShowAllProjectsPreference(!previous), !previous));
  const hidingEmptyProjects = accountScope === 'all' && !ownerFilterId && !showAllProjects;
  const searchMode = Boolean(searchQuery.trim());
  const { navigation, scopedProjectCount, resultBySessionId } = useMemo(() => {
    const ownerFilter = sidebarOwnerId ? getSidebarOwnerFilter(sidebarOwnerId) : null;
    const scopedSessions = ownerFilter ? sessions.filter(ownerFilter) : sessions;
    const scopedProjects = ownerFilter ? projects.filter(ownerFilter) : projects;
    const sessionsById = searchMode ? new Map(sessions.map((session) => [session.id, session])) : null;
    const fallbackTitleResults: SessionSearchResultDto[] = searchMode && searchStatus === 'error' ? getFallbackTitleMatches(scopedSessions, searchQuery).map((session) => ({
      session,
      titleMatched: true,
      messageMatchCount: 0,
      latestMessageMatch: null,
    })) : [];
    const searchResultsForDisplay = searchMode
      ? (searchStatus === 'error' ? fallbackTitleResults : searchResults.filter(({ session }) => !ownerFilter || ownerFilter(sessionsById?.get(session.id) ?? session)))
      : [];
    return {
      navigation: getSidebarNavigation({
        projects: scopedProjects,
        sessions: scopedSessions,
        matchingSessions: searchMode ? searchResultsForDisplay.map(({ session }) => sessionsById?.get(session.id) ?? session) : null,
        hideEmptyProjects: hidingEmptyProjects,
        orders: sidebarOrders,
      }),
      scopedProjectCount: scopedProjects.length,
      resultBySessionId: new Map(searchResultsForDisplay.map((result) => [result.session.id, result])),
    };
  }, [hidingEmptyProjects, projects, searchMode, searchQuery, searchResults, searchStatus, sessions, sidebarOrders, sidebarOwnerId]);
  const { pinnedItems, projectItems, projectRows, visibleSessionsById, sessionsOutsideServerOrder, hasContent: hasNavigationContent, showAllProjectsAction } = navigation;

  const navigationReady = navigationLoadState.status === 'ready';
  const canShowProjectEmptyState = navigationReady && !searchMode;
  const canShowAllProjects = navigationReady && showAllProjectsAction;
  const hasNoProjects = canShowProjectEmptyState && scopedProjectCount === 0;

  const showNavigationContent = hasNavigationContent || navigationReady;
  const accountInteractionPolicy = getSidebarAccountInteractionPolicy(accountScope, user?.id ?? '');
  const resourceViewType: UserResourceSelection['type'] = accountScope === 'mine' ? 'mine' : ownerFilterId ? 'user' : 'all';
  const showResourceOwner = accountScope === 'all' && !ownerFilterId;
  const dragDisabled = !accountInteractionPolicy.canOrganize || searchMode || Boolean(renamingTarget);
  const isNavigationGroupExpanded = (key: string) => searchMode || isSidebarGroupExpanded(expandedGroups, key);

  const renderProject = (projectId: string, scope: 'projects' | 'pinned') => {
    const row = projectRows.get(projectId);
    if (!row) return null;
    const groupKey = `p-${projectId}`;
    return (
      <ProjectBlock
        key={projectId}
        scope={scope}
        {...row}
        sessionsOutsideServerOrder={sessionsOutsideServerOrder}
        showEmptyState={canShowProjectEmptyState}
        activeSessionId={activeSessionId}
        expanded={isNavigationGroupExpanded(groupKey)}
        onToggle={() => toggleGroup(groupKey)}
        onSelectSession={handleSelectSession}
        onProjectMenu={openProjectMenu}
        onProjectPin={handleProjectPin}
        onProjectNewChat={handleProjectNewChat}
        onSessionMenu={openSessionMenu}
        onSessionPin={handleSessionPin}
        renamingTarget={renamingTarget}
        renameValue={renameValue}
        onRenameChange={setRenameValue}
        onRenameSubmit={renamingTarget?.type === 'project' ? handleProjectRenameSubmit : handleSessionRenameSubmit}
        onRenameCancel={() => setRenamingTarget(null)}
        contextMenuActive={contextMenu?.type === 'project' && contextMenu.projectId === projectId}
        contextMenuSessionId={contextMenu?.type === 'session' ? contextMenu.sessionId : undefined}
        isMobile={isMobile}
        dragDisabled={dragDisabled}
        canOrganize={accountInteractionPolicy.canOrganize}
        showOwner={showResourceOwner}
        dragging={activeDragId !== null}
        searchQuery={searchMode ? searchQuery : ''}
        searchResults={resultBySessionId}
      />
    );
  };

  const sidebarCollisionDetection: CollisionDetection = useCallback((args) => {
    const activeData = args.active.data.current;
    const matchingContainers = args.droppableContainers.filter((container) => (
      isMatchingSidebarDropTarget(activeData, container.data.current)
    ));
    return closestCenter({ ...args, droppableContainers: matchingContainers });
  }, []);
  const deleteSubject = deleteConfirm?.type === 'project'
    ? {
        label: '将删除项目',
        value: deleteConfirm.project.name,
        detail: deleteConfirm.impactStatus === 'ready' && deleteConfirm.impact
          ? `当前包含 ${deleteConfirm.impact.sessionCount} 个会话`
          : deleteConfirm.impactStatus === 'loading' ? '正在确认会话影响范围…' : '会话影响范围暂无法确认',
      }
    : deleteConfirm?.type === 'session'
      ? { label: '将删除会话', value: deleteConfirm.session.title }
      : undefined;
  const deleteImpacts = deleteConfirm?.type === 'project'
    ? [
        ...(deleteConfirm.impactStatus === 'ready' && deleteConfirm.impact
          ? [<><strong>{deleteConfirm.impact.sessionCount} 个会话</strong>将从当前 Relay 列表隐藏</>]
          : []),
        ...(deleteConfirm.impactStatus === 'ready' && deleteConfirm.impact && deleteConfirm.impact.linkedCodexSessionCount > 0
          ? [<><strong>{deleteConfirm.impact.linkedCodexSessionCount} 个会话</strong>关联的 Codex 原始会话保留，归档状态不变</>]
          : []),
        'Relay 数据会移入回收站，可从回收站恢复',
      ]
    : deleteConfirm?.type === 'session'
      ? deleteConfirm.impactStatus === 'ready' && deleteConfirm.impact?.hasLinkedCodexThread
        ? ['关联的 Codex 原始会话保留，归档状态不变', 'Relay 数据会移入回收站，可从回收站恢复']
        : ['Relay 数据会移入回收站，可从回收站恢复']
      : [];

  const releaseDragClickSuppression = () => {
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current;
    if (!isSidebarDragData(data) || dragDisabled) return;
    suppressClickRef.current = true;
    setActiveDragId(String(event.active.id));
    setContextMenu(null);
    setMobileDetails(null);
    closeAllOverlays();
  };

  const handleDragCancel = (_event: DragCancelEvent) => {
    setActiveDragId(null);
    releaseDragClickSuppression();
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null);
    releaseDragClickSuppression();
    const activeData = event.active.data.current;
    const overData = event.over?.data.current;
    if (!event.over || !isSidebarDragData(activeData) || !isSidebarDragData(overData)) return;
    if (activeData.scope !== overData.scope) return;

    const scope = activeData.scope;
    const currentItems = resolveSidebarItems(scope, projects, sessions, sidebarOrders[scope]);
    const move = createSidebarDropMove(currentItems, activeData.item, overData.item);
    if (!move) return;
    const previousOrder = sidebarOrders[scope] ?? { scope, custom: false, items: currentItems };
    setSidebarOrder({ scope, custom: true, items: move.items });
    const optimisticVersion = useChatStore.getState().sidebarOrderVersions[scope];

    void moveSidebarItem({ scope, item: activeData.item, before: move.before })
      .then((response) => {
        if (useChatStore.getState().sidebarOrderVersions[scope] !== optimisticVersion) return;
        setSidebarOrder(response.order);
      })
      .catch(async (error) => {
        if (useChatStore.getState().sidebarOrderVersions[scope] !== optimisticVersion) {
          useChatStore.getState().setError(error instanceof Error ? error.message : '侧栏排序失败，请重试');
          return;
        }
        setSidebarOrder(previousOrder);
        try {
          setSidebarOrders((await listSidebarOrders()).orders);
        } catch {
          // 保留拖动前快照；错误提示已足够指导用户重试。
        }
        useChatStore.getState().setError(error instanceof Error ? error.message : '侧栏排序失败，请重试');
      });
  };

  // 找当前上下文菜单对应的数据
  const menuProject = contextMenu?.type === 'project'
    ? projects.find((p) => p.id === contextMenu.projectId)
    : undefined;
  const menuSession = contextMenu?.type === 'session'
    ? sessions.find((s) => s.id === contextMenu.sessionId)
    : undefined;
  const menuProjectHasVisibleInProgressSession = menuProject
    ? sessions.some((session) => (
        resolveSessionProjectId(session, projects) === menuProject.id
        && isSessionActionInProgress(session.status)
      ))
    : false;
  const projectDeleteMenuState = menuProject
    ? getProjectDeleteMenuState(
        projectMenuDeletionImpact?.projectId === menuProject.id ? projectMenuDeletionImpact : null,
        menuProjectHasVisibleInProgressSession,
        Boolean(menuProject.deletion_protected),
        user?.defaultProjectId === menuProject.id,
      )
    : { disabled: true, reason: undefined };

  const menuResource = menuProject ?? menuSession;
  const menuInteractionPolicy = getSidebarAccountInteractionPolicy(accountScope, user?.id ?? '', menuResource?.owner);
  const canManageMenuProject = Boolean(menuProject && (user?.role === 'admin' || menuProject.access_role === 'owner' || (!menuProject.owner)));
  const contextMenuItems: ContextMenuItem[] = contextMenu?.type === 'project' && menuProject
    ? [
        ...(menuInteractionPolicy.canOrganize ? [{
          id: 'pin',
          label: menuProject.pinned ? '取消置顶' : '置顶',
          icon: <MenuIcon type="pin" pinned={!!menuProject.pinned} />,
          onSelect: () => handleProjectPin(menuProject.id),
        } satisfies ContextMenuItem] : []),
        ...(canCreateSidebarProjectSession(menuProject, menuInteractionPolicy.canOrganize) ? [{
          id: 'new-session',
          label: '新会话',
          icon: <MenuIcon type="plus" />,
          onSelect: () => handleProjectNewChat(menuProject.id),
        } satisfies ContextMenuItem] : []),
        {
          id: 'details',
          label: '查看详情',
          icon: <MenuIcon type="info" />,
          onSelect: () => setMobileDetails({ type: 'project' as const, project: menuProject }),
        },
        ...(canManageMenuProject ? [{
          id: 'rename',
          label: menuInteractionPolicy.renameLabel,
          icon: <MenuIcon type="edit" />,
          onSelect: () => handleProjectRenameStart(menuProject.id),
        } satisfies ContextMenuItem] : []),
        {
          id: 'copy-path',
          label: '复制项目路径',
          icon: <MenuIcon type="copy" />,
          onSelect: async () => {
            try {
              await copyToClipboard(menuProject.path);
            } catch {
              useChatStore.getState().setError('复制项目路径失败');
            }
          },
        },
        ...(canManageMenuProject ? [{
          id: 'project-uploads',
          label: '管理上传文件',
          icon: <MenuIcon type="files" />,
          onSelect: () => {
            if (!restoreMinimizedPanel(`project-uploads-dialog:${menuProject.id}`)) {
              setUploadsProjects((current) => current.some((project) => project.id === menuProject.id) ? current : [...current, menuProject]);
            }
            setContextMenu(null);
          },
        } satisfies ContextMenuItem] : []),
        ...((user?.role === 'admin') ? [{ id: 'project-members', label: '管理授权', icon: <MenuIcon type="members" />, onSelect: () => { if (!restoreMinimizedPanel(`project-members-dialog:${menuProject.id}`)) setMembersProjects((current) => current.some((project) => project.id === menuProject.id) ? current : [...current, menuProject]); setContextMenu(null); } } satisfies ContextMenuItem] : []),
        ...(canManageMenuProject ? [{ id: 'deletion-protection', label: menuProject.deletion_protected ? '关闭删除保护' : '开启删除保护', icon: <MenuIcon type="shield" />, onSelect: () => { const next = menuProject.deletion_protected ? 0 : 1; void updateProject(menuProject.id, { deletion_protected: next }).then(() => setProjects(projects.map((project) => project.id === menuProject.id ? { ...project, deletion_protected: next } : project))).catch(console.error); setContextMenu(null); } } satisfies ContextMenuItem] : []),
        ...(canManageMenuProject ? [{
          id: 'delete',
          label: '删除项目',
          icon: <MenuIcon type="trash" />,
          danger: true,
          disabled: projectDeleteMenuState.disabled,
          disabledReason: projectDeleteMenuState.reason,
          onSelect: () => handleProjectDeleteStart(menuProject.id),
        } satisfies ContextMenuItem] : []),
      ]
    : contextMenu?.type === 'session' && menuSession
      ? createSessionMenuItems({
          session: menuSession,
          capabilities: engineStatuses.find((status) => status.id === menuSession.engine)?.capabilities,
          onPin: menuInteractionPolicy.canOrganize ? () => handleSessionPin(menuSession.id) : undefined,
          onDetails: () => openSessionDetails(menuSession),
          onRename: () => handleSessionRenameStart(menuSession.id),
          renameLabel: menuInteractionPolicy.renameLabel,
          onCopyId: async () => {const report=localAction('session','copy_id','sidebar');
            try {
              await copyToClipboard(menuSession.id);report(true);
            } catch {
              report(false);useChatStore.getState().setError('复制会话 ID 失败');
            }
          },
          onFork: menuSession.can_fork ? () => requestSessionFork(menuSession) : undefined,
          forkPending: forkingSessionId === menuSession.id,
          onShareSession: () => handleSessionShare(menuSession),
          onUnarchive: menuSession.codex_archived ? () => handleSessionUnarchive(menuSession.id) : undefined,
          onDelete: () => handleSessionDeleteStart(menuSession.id),
        })
      : [];

  return (
    <>
      {(sidebarOpen || sidebarSwipe.swipeActive) && (
        <div
          className="fixed inset-0 z-20 bg-[var(--color-backdrop)] lg:hidden"
          style={{ opacity: sidebarSwipe.backdropOpacity }}
          onClick={sidebarOpen ? closeMobileSidebar : undefined}
        />
      )}

      <aside ref={sidebarSwipe.sidebarRef} className={`
        fixed lg:relative z-30 h-full shrink-0
        theme-surface bg-[var(--color-sidebar-bg)] border-r border-[var(--color-border)]
        ${sidebarSwipe.swipeActive ? 'transition-none' : 'transition-transform duration-200'} flex flex-col
        ${!sidebarOpen && !isMobile ? 'w-0 overflow-hidden border-r-0' : ''}
        ${getMobileSidebarTranslateClass(sidebarOpen, sidebarSwipe.swipeActive)}
      `} style={{
        width: !sidebarOpen && !isMobile ? 0 : isMobile ? 'min(288px, 82vw)' : `${sidebarWidth}px`,
        transform: sidebarSwipe.translateX === null ? undefined : `translate3d(${sidebarSwipe.translateX}px, 0, 0)`,
      }}>
        {sidebarOpen && !isMobile && (
          <Tooltip content="拖动调整侧栏宽度" placement="right" className="absolute bottom-0 right-0 top-0 z-50">
            <div
              className="group relative h-full w-1.5 cursor-col-resize transition-colors hover:bg-[var(--color-resize-hover)] focus-visible:bg-[var(--color-resize-hover)] focus-visible:outline-none"
              onMouseDown={handleResizeStart}
              onKeyDown={handleResizeKeyDown}
              role="separator"
              tabIndex={0}
              aria-label="拖动调整侧栏宽度"
              aria-orientation="vertical"
              aria-valuemin={SIDEBAR_MIN_WIDTH}
              aria-valuemax={SIDEBAR_MAX_WIDTH}
              aria-valuenow={sidebarWidth}
            >
              <div className="absolute right-0 top-1/2 h-12 w-1 -translate-y-1/2 rounded-full bg-[var(--color-border)] transition-colors group-hover:bg-[var(--color-focus-ring)] group-focus-visible:bg-[var(--color-focus-ring)]" />
            </div>
          </Tooltip>
        )}
        {/* 顶部：固定在头部 */}
        <SidebarWorkbench serviceStatus={serviceStatus} isAdmin={user?.role === 'admin'} resourceViewType={resourceViewType} selectedResourceUser={selectedResourceUser} searchQuery={searchQuery} onNewChat={handleNewChat} onOpenUserResources={() => openSidebarPanel('user-resource-dialog-title', setUserResourceDialogOpen)} onExitUserResources={restorePersonalResourceView} onSearch={beginSearch} onClearSearch={clearSearch} showAllProjectsToggle={resourceViewType === 'all' ? { checked: showAllProjects, onToggle: toggleShowAllProjects } : null} />
        {/* 列表区域 */}
        <DndContext
          sensors={sensors}
          collisionDetection={sidebarCollisionDetection}
          onDragStart={handleDragStart}
          onDragCancel={handleDragCancel}
          onDragEnd={handleDragEnd}
        >
          {showNavigationContent && searchMode && searchStatus === 'loading' && (
            <ListState kind="loading" title="正在搜索…" compact className="sidebar-navigation-state" />
          )}
          {showNavigationContent && searchMode && searchStatus === 'ready' && pinnedItems.length === 0 && projectItems.length === 0 && (
            <ListState kind="empty" title="没有匹配的会话或消息" detail="换个关键词试试" compact className="sidebar-navigation-state" />
          )}
          {showNavigationContent && searchMode && searchStatus === 'error' && (
            <ListState kind="error" title="消息搜索暂不可用" detail="当前仅匹配会话标题" compact className="sidebar-navigation-state" />
          )}
        <div
          className="flex-1 overflow-y-auto px-2 pb-2"
          onClickCapture={(event) => {
            if (!suppressClickRef.current) return;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <SidebarLoadingState
            state={navigationLoadState}
            hasContent={hasNavigationContent}
            onRetry={() => setNavigationReloadVersion((version) => version + 1)}
          />
          {/* 置顶分组 —— 无置顶内容时隐藏 */}
          {showNavigationContent && pinnedItems.length > 0 && (
            <TopGroup
              title="置顶"
              expanded={isNavigationGroupExpanded('pinned')}
              onToggle={() => toggleGroup('pinned')}
            >
              <SortableContext items={pinnedItems.filter((item) => item.type === 'project' || !sessionsOutsideServerOrder.has(item.id)).map(sidebarDragId)} strategy={verticalListSortingStrategy}>
                {pinnedItems.map((item) => {
                  if (item.type === 'project') return renderProject(item.id, 'pinned');
                  const session = visibleSessionsById.get(item.id);
                  if (!session) return null;
                  return (
                    <SessionRow
                      key={sidebarDragId(item)}
                      scope="pinned"
                      session={session}
                      active={activeSessionId === session.id}
                      onSelect={() => handleSelectSession(session.id)}
                      onMenu={(e) => openSessionMenu(e, session.id)}
                      onPin={() => handleSessionPin(session.id)}
                      renamingTarget={renamingTarget}
                      renameValue={renameValue}
                      onRenameChange={setRenameValue}
                      onRenameSubmit={handleSessionRenameSubmit}
                      onRenameCancel={() => setRenamingTarget(null)}
                      contextMenuActive={!!contextMenu && contextMenu.type === 'session' && contextMenu.sessionId === session.id}
                      isMobile={isMobile}
                      dragDisabled={dragDisabled}
                      outsideServerOrder={sessionsOutsideServerOrder.has(item.id)}
                      canOrganize={accountInteractionPolicy.canOrganize}
                      showOwner={showResourceOwner}
                      dragging={activeDragId !== null}
                      searchQuery={searchMode ? searchQuery : ''}
                      searchResult={resultBySessionId.get(session.id)}
                    />
                  );
                })}
              </SortableContext>
            </TopGroup>
          )}

          {/* 项目分组 */}
          {showNavigationContent && (projectItems.length > 0 || canShowAllProjects || hasNoProjects) && <TopGroup
            title="项目"
            expanded={isNavigationGroupExpanded('projects')}
            onToggle={() => toggleGroup('projects')}
          >
            {canShowAllProjects && (
              <button type="button" onClick={toggleShowAllProjects} className="sidebar-navigation-state sidebar-navigation-state--inline sidebar-navigation-state--action block">显示全部项目</button>
            )}
            {hasNoProjects && <span className="sidebar-navigation-state sidebar-navigation-state--inline block">暂无项目</span>}
            {projectItems.length > 0 && (
              <SortableContext items={projectItems.map(sidebarDragId)} strategy={verticalListSortingStrategy}>
                {projectItems.map((item) => renderProject(item.id, 'projects'))}
              </SortableContext>
            )}
          </TopGroup>}

        </div>
        </DndContext>

        {/* 底部 */}
        <div className="border-t border-[var(--color-border)] px-3 py-2">
          <div className="flex items-center gap-1 rounded-xl px-1">
            <div className="relative min-w-0 flex-1">
              <UserMenu
                user={user}
                anchorRect={userMenuAnchor}
                mobile={isMobile}
                onAnchorChange={(anchor) => { setContextMenu(null); setUserMenuAnchor(anchor); }}
                onClose={closeUserMenu}
                onOpenSettings={() => openSidebarPanel('account-settings-title', setAccountSettingsOpen)}
                onOpenShares={() => openSidebarPanel('my-shares-title', setMySharesOpen)}
                onOpenTrash={() => openSidebarPanel('trash-dialog-title', setTrashOpen)}
                onOpenAdministration={() => setAdministrationOpen(true)}
                onLogout={() => setLogoutConfirmOpen(true)}
              />
            </div>
          </div>
        </div>

        <ContextMenuPopup
          open={contextMenu !== null}
          anchorRect={contextMenu?.anchorRect ?? null}
          items={contextMenuItems}
          onClose={closeContextMenu}
          mobile={isMobile}
          label={contextMenu?.type === 'project' ? '项目操作' : '会话操作'}
        />

        <DetailsDialog
          open={mobileDetails !== null}
          onClose={() => setMobileDetails(null)}
          title={mobileDetails?.type === 'project' ? '项目详情' : '会话详情'}
        >
          {mobileDetails?.type === 'project' && (
            <ProjectDetailsContent project={mobileDetails.project} />
          )}
          {mobileDetails?.type === 'session' && (() => {
            const session = { ...mobileDetails.session, ...sessions.find((item) => item.id === mobileDetails.session.id) };
            const projectId = resolveSessionProjectId(session, projects);
            const project = projects.find((item) => item.id === projectId) ?? null;
            const status = getDisplayedSessionStatus(session.status);
            return <SessionDetailsContent
              session={session}
              project={project}
              status={status}
              engineSessionLoadFailed={mobileDetails.engineSessionLoadFailed}
            />;
          })()}
        </DetailsDialog>

        <ConfirmDialog
          open={deleteConfirm !== null}
          title={deleteConfirm?.type === 'project' ? '删除项目' : '删除会话'}
          tone="danger"
          description={deleteConfirm?.impactStatus === 'loading'
            ? '正在确认删除的影响范围…'
            : deleteConfirm?.impactStatus === 'unavailable'
              ? '暂时无法确认删除的影响范围，请取消后重试。'
              : deleteConfirm?.type === 'project' ? '请确认要删除的项目及其影响范围。' : '请确认要删除的会话。'}
          subject={deleteSubject}
          impacts={deleteImpacts}
          notice={deleteConfirm?.type === 'project'
            ? {
                tone: 'info',
                title: '磁盘内容会保留',
                description: '项目、会话、磁盘工作目录和已上传文件均会保留；删除后仅从当前 Relay 列表隐藏。',
              }
            : undefined}
          confirmLabel="删除"
          pendingLabel={getSessionDeletePendingLabel(deleteProgressStage)}
          confirmDisabled={deleteConfirm?.impactStatus !== 'ready'}
          onCancel={() => {
            if (deleteConfirm?.type === 'session') clearDeleteProgressStage(deleteConfirm.session.id);
            setDeleteConfirm(null);
          }}
          onConfirm={confirmDelete}
        />

        <CreateSessionFromContextDialog
          open={createSessionTarget !== null}
          sourceTitle={createSessionTarget?.title}
          fromReply={false}
          onCancel={() => setCreateSessionTarget(null)}
          onConfirm={confirmSessionFork}
        />

        <MySharesDialog open={mySharesOpen} onClose={() => setMySharesOpen(false)} mobile={isMobile} />
        <TrashDialog mobile={isMobile} open={trashOpen} admin={user?.role === 'admin'} onClose={() => setTrashOpen(false)} onChanged={() => setNavigationReloadVersion((value) => value + 1)} />
        <ShareCreateDialog draft={shareDraft} onClose={() => setShareDraft(null)} />
        <PanelReturnContext.Provider value={getAdministrationReturn}>
          {user?.role === 'admin' && <>
            <AdministrationCenter open={administrationOpen} mobile={isMobile} onClose={() => setAdministrationOpen(false)} onSelect={panel => openAdministrationPanel(panel, true)} />
            <ServiceMaintenanceDialog mobile={isMobile} open={serviceMaintenanceOpen} onClose={administrationPanels.server.close} />
            <AccountManagementDialog open={accountManagementOpen} onClose={administrationPanels.accounts.close} mobile={isMobile} />
            {pageHostingOpen && <Suspense fallback={null}><PageHostingPanel importRequest={hostingRequest} onClose={administrationPanels.pages.close} mobile={isMobile} /></Suspense>}
          </>}
          <EngineMaintenanceDialog mobile={isMobile} surface={administrationOrigins.engines ? 'user_menu' : 'composer'} requestedEngine={requestedMaintenanceEngine} open={engineMaintenanceOpen} onClose={administrationPanels.engines.close} />
        </PanelReturnContext.Provider>
        <SettingsCenterDialog open={accountSettingsOpen} onClose={() => setAccountSettingsOpen(false)} mobile={isMobile} />
        {user?.role === 'admin' && <UserResourceDialog open={userResourceDialogOpen} onClose={() => setUserResourceDialogOpen(false)} mobile={isMobile} currentUser={user} selectedType={resourceViewType} selectedUserId={ownerFilterId} onSelect={selectUserResourceView} />}
        {uploadsProjects.map((project) => <ProjectUploadsDialog key={project.id} project={project} onClose={() => setUploadsProjects((current) => current.filter((item) => item.id !== project.id))} />)}
        {membersProjects.map((project) => <ProjectMembersDialog key={project.id} project={project} onClose={() => setMembersProjects((current) => current.filter((item) => item.id !== project.id))} onProjectUpdated={(updated) => { setMembersProjects((current) => current.map((item) => item.id === updated.id ? updated : item)); setProjects(projects.map((item) => item.id === updated.id ? updated : item)); }} />)}

        <ConfirmDialog
          open={logoutConfirmOpen}
          title="退出登录"
          tone="neutral"
          description="确定要退出当前账号吗？"
          subject={user ? { label: '当前账号', value: user.displayName, detail: user.username } : undefined}
          impacts={['仅当前设备的登录状态会失效', '其他设备上的登录状态不受影响']}
          confirmLabel="退出登录"
          onCancel={() => setLogoutConfirmOpen(false)}
          onConfirm={() => {
            setLogoutConfirmOpen(false);
            return logout();
          }}
        />
      </aside>
    </>
  );
}
