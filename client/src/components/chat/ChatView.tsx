import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { RespondInteractionCommand } from '../../generated/relay-contracts';
import { useChatStore } from '../../stores/chat';
import { hasBlockingFollowups, useSessionFollowupStore } from '../../stores/session-followups';
import { useSessionOperationErrorStore } from '../../stores/session-operation-errors';
import { SessionFollowupStatus } from './SessionFollowupStatus';
import { useRelayWebSocket } from '../../hooks/useRelayWebSocket';
import { getSessionInputState, isSessionRunning } from '../../hooks/session-streaming';
import { generateUUID } from '../../utils/uuid';
import { createSession, deleteSession, forkSession, getMessageDetails, getMessagePage, getSession, getSessionDeletionImpact, MESSAGE_PAGE_SIZE, searchSessionMessages, unarchiveSession, updateSession as updateSessionRequest } from '../../api/sessions';
import { ApiError } from '../../api/client';
import { copyToClipboard } from '../../utils/clipboard';
import { createSessionMenuItems } from './session-menu-items';
import { isSessionActionInProgress } from './session-action-state';
import { useSessionDeleteProgress } from './use-session-delete-progress';
import type { ShareDraft } from '../sharing/ShareCreateDialog';
import { getSelectableMessageIds, normalizeSelectedMessageIds } from '../sharing/share-selection';
import SessionDetailsContent from '../layout/SessionDetailsContent';
import { getDisplayedSessionStatus } from '../layout/session-status';
import { getSidebarAccountInteractionPolicy } from '../layout/sidebar-account-interactions';
import { getChatInitializationState } from './chat-initialization-state';
import { selectRecentSession } from './empty-state-shortcuts';
import { useSessionSearchStore } from '../../stores/session-search';
import { loadSearchHistoryUntilCurrentTarget, type SearchHistoryTarget } from './session-search-history-loader';
import { moveSearchMatchIndex } from './session-search-navigation';
import { retainExpandedViewportHeight, shouldKeepComposerBehindSearchKeyboard } from './mobile-search-keyboard';
import { LATEST_MESSAGE_LOADING_DELAY_MS, MESSAGE_INITIAL_REQUEST_TIMEOUT_MS, getLatestMessageBubbleStatus, isLatestMessageReplyMissing, shouldRefreshOnPageShow, shouldReconnectAfterResume, type LatestMessageRefreshStatus } from './latest-message-refresh';
import type { EngineId, EnginePreferencesDto, SendAttachmentDto } from '../../generated/relay-contracts';
import { buildOptimisticUserMessage } from './send-message-presentation';
import { engineLabel } from '../../engine/catalog';
import TrashProjectRecoveryDialog, { useTrashProjectRecovery } from '../trash/TrashProjectRecoveryDialog';
import { settleCreatedSessionFirstSend, shouldAutoActivateCreatedSession } from './new-session-first-send';
import { clearWorkspaceTaskLaunch, readWorkspaceTaskLaunch } from '../workspace-console/workspace-task-launch';
import { invalidateWorkspaceDashboard } from '../workspace-console/workspace-console-cache';
import { disposeSessionSummaryRequest, isCurrentSessionSummaryRequest, replaceSessionSummaryRequest, type SessionSummaryRequest } from './session-summary-controller';
import { loadMessageRegion } from './message-region-controller';
import { readMessageCache, scheduleMessageCacheWrite } from '../../cache/message-cache';
import { createCacheableMessageSummary } from '../../cache/message-cache-policy';
import { useAuth } from '../../auth/AuthContext';
import { restoreMinimizedPanel } from '../ui/minimizedPanelRegistry';
import { cancelQueuedTurn } from '../../api/engine-concurrency';
import { useEngineConcurrencyStore } from '../../stores/engine-concurrency';
import { resolveQueuedTurnUiState } from './queued-turn-status';
import { messageDetailsController } from './message-details-controller';
import { selectSuggestedReplyCandidate } from './suggested-reply';
import type { ComposerFocusOutletContext } from './composer-focus';
import { publishResourceDeletionNotice } from '../../stores/resource-deletion-notice';
import { useEngineStatuses } from './use-engine-statuses';
import { resolveDefaultEngine } from './default-engine';
import { ChatViewComposerRegion, ChatViewDialogs, ChatViewHeaderRegion, ChatViewMessageRegion, type ChatViewDeleteTarget } from './ChatViewPresentation';
function getScreenOrientationKey(): string {
  if (typeof window === 'undefined') return 'unknown';
  return window.screen.orientation?.type
    ?? (window.screen.width >= window.screen.height ? 'landscape' : 'portrait');
}
export default function ChatView() {
  const { composerFocusRequest, requestComposerFocus, registerComposerFocusHandler } = useOutletContext<ComposerFocusOutletContext>();
  const { user } = useAuth();
  const { send, cancel, cancelFollowup, resumeFollowups, respondToInteraction, reconnect, resyncSession } = useRelayWebSocket();
  const followupsBySession = useSessionFollowupStore((state) => state.bySession);
  const operationErrorsBySession = useSessionOperationErrorStore(state => state.bySession);
  const {
    activeSessionId,
    activeSessionOpenVersion,
    navigationLoadState,
    messageLoadBySession,
    beginMessageLoad,
    failMessageLoad,
    updateMessageRegion,
    setActiveSession,
    messages,
    mergeMessages,
    prependMessages,
    addMessage,
    removeMessage,
    streaming,
    sessions,
    upsertSession,
    sessionSummaryLoadById,
    beginSessionSummaryLoad,
    completeSessionSummaryLoad,
    failSessionSummaryLoad,
    setError,
    addSession,
    currentProjectId,
    projects,
    addProject,
    setCurrentProject,
    pendingProjectPath,
    setPendingProject,
    updateSessionPinned,
    updateSessionTitle,
    updateSession,
    removeSession,
    sidebarOpen,
    sidebarAccountScope,
    toggleSidebar,
    connectionError,
    protocolMismatch,
  } = useChatStore();
  const taskLaunchNavigationRef = useRef({ version: activeSessionOpenVersion, projectId: currentProjectId, sessionId: activeSessionId });
  useEffect(() => {
    const previous = taskLaunchNavigationRef.current;
    taskLaunchNavigationRef.current = { version: activeSessionOpenVersion, projectId: currentProjectId, sessionId: activeSessionId };
    if (typeof sessionStorage !== 'undefined' && (previous.version !== activeSessionOpenVersion || previous.projectId !== currentProjectId || previous.sessionId !== activeSessionId)) {
      clearWorkspaceTaskLaunch(sessionStorage);
    }
  }, [activeSessionOpenVersion, currentProjectId, activeSessionId]);
  const [titleMenuAnchor, setTitleMenuAnchor] = useState<DOMRect | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChatViewDeleteTarget | null>(null);
  const { beginDelete, cancelDelete, confirmDelete, deletePendingLabel } = useSessionDeleteProgress({
    deleteTarget, onClose: () => setDeleteTarget(null), onDeleted: removeSession, onError: setError,
  });
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1024);
  const [wideLayout, setWideLayout] = useState(false);
  const [shareDraft, setShareDraft] = useState<ShareDraft | null>(null);
  const [shareUnavailableOpen, setShareUnavailableOpen] = useState(false);
  const trashProjectRecovery = useTrashProjectRecovery();
  const [shareSelectionMode, setShareSelectionMode] = useState(false);
  const [selectedShareMessageIds, setSelectedShareMessageIds] = useState<Set<string>>(new Set());
  const { engineStatuses, engineStatusState, applyEngineStatusSnapshot } = useEngineStatuses();
  const [newSessionEngine, setNewSessionEngine] = useState<EngineId | null>(null);
  const [engineFallbackNotice, setEngineFallbackNotice] = useState<string | null>(null);
  const [cancellingQueuedSessionId, setCancellingQueuedSessionId] = useState<string | null>(null);
  const [forkingTarget, setForkingTarget] = useState<'tail' | string | null>(null);
  const [createSessionTarget, setCreateSessionTarget] = useState<{
    sourceSessionId: string;
    sourceTitle: string;
    messageId?: string;
  } | null>(null);
  const engineSelectionContextRef = useRef('');
  const searchQuery = useSessionSearchStore((state) => state.matchQuery);
  const searchStatus = useSessionSearchStore((state) => state.matchStatus);
  const searchError = useSessionSearchStore((state) => state.matchError);
  const activeMatchSessionId = useSessionSearchStore((state) => state.activeMatchSessionId);
  const searchMatches = useSessionSearchStore((state) => state.matches);
  const totalSearchMatches = useSessionSearchStore((state) => state.totalMatches);
  const searchMatchesTruncated = useSessionSearchStore((state) => state.matchesTruncated);
  const currentSearchMatchIndex = useSessionSearchStore((state) => state.currentMatchIndex);
  const searchTargetMessageId = useSessionSearchStore((state) => state.targetMessageId);
  const setSessionMatches = useSessionSearchStore((state) => state.setSessionMatches);
  const selectSearchMatch = useSessionSearchStore((state) => state.selectMatch);
  const beginMatchSearch = useSessionSearchStore((state) => state.beginMatchSearch);
  const applySessionMatches = useSessionSearchStore((state) => state.applySessionMatches);
  const failMatchSearch = useSessionSearchStore((state) => state.failMatchSearch);
  const clearSearch = useSessionSearchStore((state) => state.clearSearch);
  const clearCurrentSearch = useSessionSearchStore((state) => state.clearCurrentSearch);
  const [currentSearchOpen, setCurrentSearchOpen] = useState(false);
  const [currentSearchInput, setCurrentSearchInput] = useState('');
  const [includeProcessSearch, setIncludeProcessSearch] = useState(false);
  const [includeOperationsSearch, setIncludeOperationsSearch] = useState(false);
  const [searchInputFocused, setSearchInputFocused] = useState(false);
  const [keepComposerBehindSearchKeyboard, setKeepComposerBehindSearchKeyboard] = useState(false);
  const expandedViewportHeightRef = useRef(
    typeof window === 'undefined' ? 0 : (window.visualViewport?.height ?? window.innerHeight),
  );
  const viewportOrientationRef = useRef(getScreenOrientationKey());
  const [searchHistoryStatus, setSearchHistoryStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const currentSearchOpenRef = useRef(currentSearchOpen);
  currentSearchOpenRef.current = currentSearchOpen;
  const refreshedMissingTargetRef = useRef<string | null>(null);
  const searchHistoryTargetRef = useRef<(SearchHistoryTarget & { query: string }) | null>(null);
  const searchHistoryLoadRef = useRef<Promise<void> | null>(null);
  const startSearchHistoryLoadRef = useRef<() => void>(() => undefined);
  const pendingSearchNavigationRef = useRef<{
    sessionId: string;
    query: string;
    matchIndex: number;
    messageId: string;
  } | null>(null);
  const searchHistoryRetryBlockedRef = useRef(false);
  const searchDetailsRetryRef = useRef<{ sessionId: string; messageId: string } | null>(null);
  const messageRefreshGenerationRef = useRef(0);
  const messageRefreshDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageRefreshPendingRef = useRef<{
    sessionId: string;
    generation: number;
    baseline: unknown;
  } | null>(null);
  const hiddenAtRef = useRef<number | null>(
    typeof document !== 'undefined' && document.visibilityState === 'hidden' ? Date.now() : null,
  );
  const lastResumeReconnectAtRef = useRef(0);
  const [messageRefreshNonce, setMessageRefreshNonce] = useState(0);
  const [latestMessagesRefreshStatus, setLatestMessagesRefreshStatus] = useState<LatestMessageRefreshStatus>('idle');
  const [latestMessagesRefreshVisible, setLatestMessagesRefreshVisible] = useState(false);
  const sessionSummaryRequestRef = useRef<SessionSummaryRequest | null>(null);
  const cacheRevisionScheduledRef = useRef(new Map<string, number>());
  const [sessionSummaryReloadVersion, setSessionSummaryReloadVersion] = useState(0);
  useEffect(() => {
    messageDetailsController.clear();
    return () => messageDetailsController.clear();
  }, [user?.id]);
  const clearMessageRefreshDelay = useCallback(() => {
    if (!messageRefreshDelayTimerRef.current) return;
    clearTimeout(messageRefreshDelayTimerRef.current);
    messageRefreshDelayTimerRef.current = null;
  }, []);
  const requestLatestMessagesRefresh = useCallback(() => {
    setMessageRefreshNonce((value) => value + 1);
  }, []);
  const completeLatestMessagesRefresh = useCallback((sessionId: string, generation: number) => {
    const pending = messageRefreshPendingRef.current;
    if (!pending || pending.sessionId !== sessionId || pending.generation !== generation) return;
    messageRefreshPendingRef.current = null;
    clearMessageRefreshDelay();
    setLatestMessagesRefreshStatus('idle');
    setLatestMessagesRefreshVisible(false);
  }, [clearMessageRefreshDelay]);
  const reconnectAfterResume = useCallback(() => {
    const now = Date.now();
    if (now - lastResumeReconnectAtRef.current < 1_000) return;
    lastResumeReconnectAtRef.current = now;
    reconnect();
  }, [reconnect]);

  const resetSearchHistoryNavigation = useCallback(() => {
    searchHistoryTargetRef.current = null;
    pendingSearchNavigationRef.current = null;
    searchHistoryRetryBlockedRef.current = false;
    refreshedMissingTargetRef.current = null;
    setSearchHistoryStatus('idle');
  }, []);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 1024);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!activeSessionId) {
      disposeSessionSummaryRequest(sessionSummaryRequestRef.current);
      sessionSummaryRequestRef.current = null;
      return;
    }
    const sessionId = activeSessionId;
    const generation = beginSessionSummaryLoad(sessionId);
    const request = replaceSessionSummaryRequest(sessionSummaryRequestRef.current, sessionId, generation);
    sessionSummaryRequestRef.current = request;
    void getSession(sessionId, { signal: request.controller.signal })
      .then((session) => {
        const state = useChatStore.getState();
        if (!isCurrentSessionSummaryRequest(
          request,
          state.activeSessionId,
          state.sessionSummaryLoadById[sessionId]?.generation ?? 0,
        )) return;
        upsertSession(session);
        completeSessionSummaryLoad(sessionId, generation);
      })
      .catch((error) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        const state = useChatStore.getState();
        if (!isCurrentSessionSummaryRequest(
          request,
          state.activeSessionId,
          state.sessionSummaryLoadById[sessionId]?.generation ?? 0,
        )) return;
        if (error instanceof ApiError && error.status === 404) {
          failSessionSummaryLoad(sessionId, generation, '会话不存在或已删除');
          if (state.navigationLoadState.status !== 'loading') {
            removeSession(sessionId);
            publishResourceDeletionNotice('会话已删除。');
          }
          return;
        }
        failSessionSummaryLoad(sessionId, generation, error instanceof Error ? error.message : '会话信息加载失败');
      });
    return () => request.controller.abort();
  }, [activeSessionId, beginSessionSummaryLoad, completeSessionSummaryLoad, failSessionSummaryLoad, removeSession, sessionSummaryReloadVersion, upsertSession]);

  useEffect(() => () => disposeSessionSummaryRequest(sessionSummaryRequestRef.current), []);

  useEffect(() => {
    const measureKeyboard = () => {
      const currentViewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const currentOrientation = getScreenOrientationKey();
      if (!isMobile || currentOrientation !== viewportOrientationRef.current) {
        expandedViewportHeightRef.current = currentViewportHeight;
        viewportOrientationRef.current = currentOrientation;
      } else {
        expandedViewportHeightRef.current = retainExpandedViewportHeight(
          expandedViewportHeightRef.current,
          currentViewportHeight,
        );
      }
      setKeepComposerBehindSearchKeyboard(shouldKeepComposerBehindSearchKeyboard({
        mobile: isMobile,
        searchInputFocused,
        expandedViewportHeight: expandedViewportHeightRef.current,
        currentViewportHeight,
      }));
    };

    measureKeyboard();
    window.visualViewport?.addEventListener('resize', measureKeyboard);
    window.addEventListener('resize', measureKeyboard);
    return () => {
      window.visualViewport?.removeEventListener('resize', measureKeyboard);
      window.removeEventListener('resize', measureKeyboard);
    };
  }, [isMobile, searchInputFocused]);

  useEffect(() => {
    if (!currentSearchOpen) setSearchInputFocused(false);
  }, [currentSearchOpen]);

  const closeCurrentSearch = useCallback(() => {
    requestComposerFocus('search-closed');
    setCurrentSearchOpen(false);
    setCurrentSearchInput('');
    clearCurrentSearch();
    resetSearchHistoryNavigation();
  }, [clearCurrentSearch, requestComposerFocus, resetSearchHistoryNavigation]);

  useEffect(() => {
    resetSearchHistoryNavigation();
    const matchState = useSessionSearchStore.getState();
    if (matchState.activeMatchSessionId === activeSessionId && matchState.matchQuery) {
      setCurrentSearchInput(matchState.matchQuery);
      setCurrentSearchOpen(true);
      return;
    }
    setCurrentSearchOpen(false);
    setCurrentSearchInput('');
    if (currentSearchOpenRef.current) clearCurrentSearch();
  }, [activeSessionId, clearCurrentSearch, resetSearchHistoryNavigation]);

  useEffect(() => {
    if (currentSearchOpen || activeMatchSessionId !== activeSessionId || !searchQuery) return;
    setCurrentSearchInput(searchQuery);
    setCurrentSearchOpen(true);
  }, [activeMatchSessionId, activeSessionId, currentSearchOpen, searchQuery]);

  const runCurrentSearch = useCallback((query: string) => {
    if (!activeSessionId) return;
    resetSearchHistoryNavigation();
    const requestId = beginMatchSearch(query);
    if (!query.trim()) return;
    void searchSessionMessages(activeSessionId, query.trim(), 500, {
      includeProcess: includeProcessSearch,
      includeOperations: includeOperationsSearch,
    }).then((response) => applySessionMatches(requestId, activeSessionId, response))
      .catch((error) => failMatchSearch(requestId, error instanceof Error ? error.message : '搜索失败'));
  }, [activeSessionId, applySessionMatches, beginMatchSearch, failMatchSearch, includeOperationsSearch, includeProcessSearch, resetSearchHistoryNavigation]);

  useEffect(() => {
    if (!currentSearchOpen) return;
    const timer = window.setTimeout(() => runCurrentSearch(currentSearchInput), 250);
    return () => window.clearTimeout(timer);
  }, [currentSearchInput, currentSearchOpen, includeOperationsSearch, includeProcessSearch, runCurrentSearch]);

  const closeTitleMenu = useCallback(() => setTitleMenuAnchor(null), []);

  useEffect(() => {
    const refreshAfterResume = (forceReconnect: boolean) => {
      requestLatestMessagesRefresh();
      if (forceReconnect) reconnectAfterResume();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAtRef.current = Date.now();
        return;
      }
      const now = Date.now();
      const reconnectStaleSocket = shouldReconnectAfterResume(hiddenAtRef.current, now, false);
      hiddenAtRef.current = null;
      refreshAfterResume(reconnectStaleSocket);
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      if (!shouldRefreshOnPageShow(event.persisted)) return;
      const now = Date.now();
      const reconnectStaleSocket = shouldReconnectAfterResume(hiddenAtRef.current, now, event.persisted);
      hiddenAtRef.current = null;
      refreshAfterResume(reconnectStaleSocket);
    };
    const handleOnline = () => refreshAfterResume(true);

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('online', handleOnline);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('online', handleOnline);
    };
  }, [reconnectAfterResume, requestLatestMessagesRefresh]);

  // 加载会话消息
  useEffect(() => {
    if (!activeSessionId) {
      messageRefreshGenerationRef.current += 1;
      messageRefreshPendingRef.current = null;
      clearMessageRefreshDelay();
      setLatestMessagesRefreshStatus('idle');
      setLatestMessagesRefreshVisible(false);
      return;
    }

    const sessionId = activeSessionId;
    const generation = ++messageRefreshGenerationRef.current;
    const regionGeneration = beginMessageLoad(sessionId);
    const controller = new AbortController();
    const initialState = useChatStore.getState();
    const cachedMessages = initialState.messages[sessionId];
    const initialRegion = initialState.messageLoadBySession[sessionId];
    const knownRevision = initialRegion && !initialRegion.dirty && initialRegion.cacheSource !== 'none'
      ? initialRegion.revision
      : null;
    messageRefreshPendingRef.current = {
      sessionId,
      generation,
      baseline: useChatStore.getState().messages[sessionId],
    };
    clearMessageRefreshDelay();
    setLatestMessagesRefreshStatus('loading');
    setLatestMessagesRefreshVisible(false);
    messageRefreshDelayTimerRef.current = setTimeout(() => {
      const pending = messageRefreshPendingRef.current;
      if (pending?.sessionId === sessionId && pending.generation === generation) {
        setLatestMessagesRefreshVisible(true);
      }
    }, LATEST_MESSAGE_LOADING_DELAY_MS);
    const isCurrent = () => {
      const state = useChatStore.getState();
      return state.activeSessionId === sessionId
        && messageRefreshGenerationRef.current === generation
        && state.messageLoadBySession[sessionId]?.generation === regionGeneration
        && !controller.signal.aborted;
    };
    void loadMessageRegion({
      readCache: () => user ? readMessageCache(user.id, sessionId) : Promise.resolve(null),
      requestNetwork: () => getMessagePage(sessionId, {
        knownRevision,
        signal: controller.signal,
        timeoutMs: MESSAGE_INITIAL_REQUEST_TIMEOUT_MS,
      }),
      isCurrent,
      applyCache: (page) => {
        mergeMessages(sessionId, page.messages.map((message) => ({ ...message, deferredMarkdown: true })));
        updateMessageRegion(sessionId, regionGeneration, {
          status: 'loading', error: null, revision: page.revision, cacheSource: 'indexeddb',
          hasMore: page.hasMore, nextCursor: page.nextCursor, dirty: false,
        });
      },
      applyNetwork: (page) => {
        mergeMessages(sessionId, page.messages.map((message) => ({ ...message, deferredMarkdown: false })));
        updateMessageRegion(sessionId, regionGeneration, {
          status: 'ready', error: null, revision: page.revision, cacheSource: 'network',
          hasMore: page.hasMore, nextCursor: page.nextCursor, dirty: false,
        });
        completeLatestMessagesRefresh(sessionId, generation);
      },
      applyUnchanged: (revision) => {
        updateMessageRegion(sessionId, regionGeneration, {
          status: 'ready', error: null, revision, cacheSource: cachedMessages?.length ? 'memory' : 'network', dirty: false,
        });
        completeLatestMessagesRefresh(sessionId, generation);
      },
      applyError: (error) => {
        const pending = messageRefreshPendingRef.current;
        if (!pending || pending.sessionId !== sessionId || pending.generation !== generation) return;
        console.error(error);
        messageRefreshPendingRef.current = null;
        clearMessageRefreshDelay();
        setLatestMessagesRefreshStatus('error');
        setLatestMessagesRefreshVisible(true);
        failMessageLoad(sessionId, regionGeneration, error instanceof Error ? error.message : '消息加载失败');
      },
      writeCache: (page) => {
        if (user) {
          cacheRevisionScheduledRef.current.set(sessionId, page.revision);
          scheduleMessageCacheWrite(user.id, page);
        }
      },
    });

    return () => {
      controller.abort();
      if (messageRefreshGenerationRef.current === generation) {
        messageRefreshGenerationRef.current += 1;
      }
    };
  }, [activeSessionId, activeSessionOpenVersion, beginMessageLoad, clearMessageRefreshDelay, completeLatestMessagesRefresh, failMessageLoad, mergeMessages, messageRefreshNonce, updateMessageRegion, user]);

  useEffect(() => () => clearMessageRefreshDelay(), [clearMessageRefreshDelay]);

  const ensureMessageDetails = useCallback(async (sessionId: string, messageId: string) => {
    const existing = (useChatStore.getState().messages[sessionId] || []).find((message) => message.id === messageId);
    if (!existing) throw new Error('目标消息尚未加载');
    if (existing.detailsLoaded || existing.items || existing.processContent || existing.processTimeline) return;
    const details = await messageDetailsController.load(sessionId, messageId, getMessageDetails);
    const current = (useChatStore.getState().messages[sessionId] || []).find((message) => message.id === messageId);
    if (!current) return;
    const { sessionId: _detailsSessionId, messageId: _detailsMessageId, ...detailFields } = details;
    mergeMessages(sessionId, [{
      ...current,
      ...detailFields,
      detailsLoaded: true,
    }]);
  }, [mergeMessages]);

  const startSearchHistoryLoad = useCallback(() => {
    if (searchHistoryLoadRef.current) return;
    const loadPromise = loadSearchHistoryUntilCurrentTarget({
      getTarget: () => searchHistoryTargetRef.current,
      getLoadedMessages: (sessionId) => useChatStore.getState().messages[sessionId] || [],
      loadOlderMessages: async (sessionId, limit) => {
        const state = useChatStore.getState();
        const region = state.messageLoadBySession[sessionId];
        if (!region?.hasMore || !region.nextCursor) return { messages: [], hasMore: false };
        const result = await getMessagePage(sessionId, { limit, cursor: region.nextCursor });
        if (result.unchanged) return { messages: [], hasMore: false };
        updateMessageRegion(sessionId, region.generation, {
          revision: result.page.revision,
          hasMore: result.page.hasMore,
          nextCursor: result.page.nextCursor,
          cacheSource: 'network',
        });
        return { messages: result.page.messages, hasMore: result.page.hasMore };
      },
      prependMessages,
    }).then(async (result) => {
      if (result.status === 'loaded') {
        const pending = pendingSearchNavigationRef.current;
        if (pending
          && pending.sessionId === result.target.sessionId
          && pending.messageId === result.target.messageId
          && useSessionSearchStore.getState().matchQuery.trim() === pending.query) {
          selectSearchMatch(pending.matchIndex);
          pendingSearchNavigationRef.current = null;
          setSearchHistoryStatus('idle');
        }
        return;
      }
      if (result.status !== 'missing') return;
      const target = searchHistoryTargetRef.current;
      if (!target || target.sessionId !== result.target.sessionId || target.messageId !== result.target.messageId) return;
      const pending = pendingSearchNavigationRef.current;
      if (pending
        && pending.sessionId === target.sessionId
        && pending.messageId === target.messageId
        && pending.query === target.query) {
        searchHistoryRetryBlockedRef.current = true;
        setSearchHistoryStatus('error');
        searchHistoryTargetRef.current = null;
        return;
      }
      const targetKey = `${target.sessionId}:${target.query}:${target.messageId}`;
      if (refreshedMissingTargetRef.current === targetKey) {
        searchHistoryRetryBlockedRef.current = true;
        setSearchHistoryStatus('error');
        searchHistoryTargetRef.current = null;
        return;
      }
      refreshedMissingTargetRef.current = targetKey;
      const response = await searchSessionMessages(target.sessionId, target.query, 500, {
        includeProcess: includeProcessSearch,
        includeOperations: includeOperationsSearch,
      });
      if (useSessionSearchStore.getState().matchQuery.trim() === target.query) {
        setSessionMatches(target.sessionId, response);
      }
      searchHistoryTargetRef.current = null;
    }).catch((error) => {
      const target = searchHistoryTargetRef.current;
      if (target) {
        searchHistoryRetryBlockedRef.current = true;
        if (pendingSearchNavigationRef.current) setSearchHistoryStatus('error');
        else setError(error instanceof Error ? error.message : '定位匹配消息失败', target.sessionId);
      }
    }).finally(() => {
      searchHistoryLoadRef.current = null;
      const target = searchHistoryTargetRef.current;
      if (!target) return;
      const targetLoaded = (useChatStore.getState().messages[target.sessionId] || [])
        .some((message) => message.id === target.messageId);
      if (!targetLoaded && !searchHistoryRetryBlockedRef.current) queueMicrotask(() => startSearchHistoryLoadRef.current());
    });
    searchHistoryLoadRef.current = loadPromise;
  }, [includeOperationsSearch, includeProcessSearch, prependMessages, selectSearchMatch, setError, setSessionMatches, updateMessageRegion]);
  startSearchHistoryLoadRef.current = startSearchHistoryLoad;

  useEffect(() => {
    const sessionId = activeSessionId;
    const targetMessageId = activeMatchSessionId === sessionId ? searchTargetMessageId : null;
    const normalizedQuery = searchQuery.trim();
    if (!sessionId || !targetMessageId || !normalizedQuery) {
      searchHistoryTargetRef.current = null;
      refreshedMissingTargetRef.current = null;
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(useChatStore.getState().messages, sessionId)) return;
    searchHistoryTargetRef.current = { sessionId, messageId: targetMessageId, query: normalizedQuery };
    searchHistoryRetryBlockedRef.current = false;
    startSearchHistoryLoad();
  }, [activeMatchSessionId, activeSessionId, searchQuery, searchTargetMessageId, startSearchHistoryLoad]);

  useEffect(() => () => {
    searchHistoryTargetRef.current = null;
  }, []);

  const navigateSearchMatch = useCallback((direction: 'previous' | 'next') => {
    if (searchHistoryStatus !== 'idle' || !activeSessionId) return;
    const nextIndex = moveSearchMatchIndex(currentSearchMatchIndex, searchMatches.length, direction);
    if (nextIndex < 0 || nextIndex === currentSearchMatchIndex) return;
    const nextMatch = searchMatches[nextIndex];
    const targetLoaded = (useChatStore.getState().messages[activeSessionId] || [])
      .some((message) => message.id === nextMatch.messageId);
    if (targetLoaded) {
      selectSearchMatch(nextIndex);
      return;
    }

    const normalizedQuery = searchQuery.trim();
    pendingSearchNavigationRef.current = {
      sessionId: activeSessionId,
      query: normalizedQuery,
      matchIndex: nextIndex,
      messageId: nextMatch.messageId,
    };
    searchHistoryTargetRef.current = {
      sessionId: activeSessionId,
      messageId: nextMatch.messageId,
      query: normalizedQuery,
    };
    searchHistoryRetryBlockedRef.current = false;
    setSearchHistoryStatus('loading');
    startSearchHistoryLoad();
  }, [activeSessionId, currentSearchMatchIndex, searchHistoryStatus, searchMatches, searchQuery, selectSearchMatch, startSearchHistoryLoad]);

  const retrySearchHistoryLoad = useCallback(() => {
    const detailsTarget = searchDetailsRetryRef.current;
    if (detailsTarget) {
      setSearchHistoryStatus('loading');
      void ensureMessageDetails(detailsTarget.sessionId, detailsTarget.messageId).then(() => {
        searchDetailsRetryRef.current = null;
        setSearchHistoryStatus('idle');
      }).catch(() => setSearchHistoryStatus('error'));
      return;
    }
    const pending = pendingSearchNavigationRef.current;
    if (!pending) return;
    searchHistoryTargetRef.current = {
      sessionId: pending.sessionId,
      messageId: pending.messageId,
      query: pending.query,
    };
    searchHistoryRetryBlockedRef.current = false;
    setSearchHistoryStatus('loading');
    startSearchHistoryLoad();
  }, [ensureMessageDetails, startSearchHistoryLoad]);

  const ensureProjectForInput = async (commitLocation = true): Promise<string> => {
    let targetProjectId = currentProjectId;
    if (pendingProjectPath) {
      const project = await trashProjectRecovery.createOrPrompt(pendingProjectPath);
      addProject(project);
      if (commitLocation) {
        setCurrentProject(project.id);
        setPendingProject(null);
      }
      targetProjectId = project.id;
    }
    if (!targetProjectId) throw new Error('请先选择项目');
    return targetProjectId;
  };

  useEffect(() => {
    if (activeSessionId || engineStatuses.length === 0 || !currentProjectId) return;
    const preferred = user?.defaultEngine ?? 'codex';
    const resolved = resolveDefaultEngine(preferred, engineStatuses);
    setNewSessionEngine(resolved.engine);
    setEngineFallbackNotice(resolved.fallback ? `默认 ${engineLabel(preferred)} 当前不可用，本次已临时回退` : null);
  }, [activeSessionId, currentProjectId, engineStatuses, user?.defaultEngine]);

  const handleSend = async (content: string, attachments: SendAttachmentDto[], messageId: string, onConfirmationState?: (state: 'verifying') => void, enginePreferences?: EnginePreferencesDto, replyToAsyncQuestionId?: string): Promise<boolean> => {
    if (managementBrowseEmpty) return false;
    clearSearch();
    resetSearchHistoryNavigation();
    setCurrentSearchOpen(false);
    setCurrentSearchInput('');
    let targetSessionId = activeSessionId;
    let targetProjectId: string | null = null;
    let workspaceTaskId: string | undefined;
    let workspaceTaskTitle: string | undefined;
    let hasWorkspaceTaskLaunch = false;
    const creatingSession = !targetSessionId;
    const navigationVersionAtSend = activeSessionOpenVersion;
    try {
      targetProjectId = await ensureProjectForInput();
      if (creatingSession && typeof sessionStorage !== 'undefined') {
        const taskLaunch = readWorkspaceTaskLaunch(sessionStorage, targetProjectId, Date.now());
        hasWorkspaceTaskLaunch = Boolean(taskLaunch);
        workspaceTaskId = taskLaunch?.taskId;
        workspaceTaskTitle = taskLaunch?.title;
      }
      if (!targetSessionId) {
        const session = await createSession(targetProjectId, workspaceTaskTitle, null);
        addSession(session);
        targetSessionId = session.id;
      }
    } catch (error: unknown) {
      setError('创建会话失败：' + (error instanceof Error ? error.message : '未知错误'));
      return false;
    }

    const isRunningFollowup = !creatingSession && (isSessionRunning(streaming, targetSessionId)
      || Boolean(queuedTurn)
      || hasBlockingFollowups(followupsBySession[targetSessionId])
      || ['processing', 'recovering', 'awaiting_action', 'stopping'].includes(currentSession?.status || ''));
    if (!isRunningFollowup) addMessage(targetSessionId, buildOptimisticUserMessage({ sessionId: targetSessionId, messageId, content, attachments, replyToAsyncQuestionId }));
    try {
      const selectedEngine = currentSession?.engine ?? newSessionEngine;
      const sendMessage = async () => {
        if (!selectedEngine) throw new Error('请选择一个可用的 AI 引擎');
        await send(targetSessionId, content, messageId, attachments, onConfirmationState, selectedEngine, enginePreferences, workspaceTaskId, replyToAsyncQuestionId);
      };
      if (creatingSession) {
        await settleCreatedSessionFirstSend({
          send: sendMessage,
          verify: async () => {
            try {
              await getMessageDetails(targetSessionId, messageId, { timeoutMs: 3_000 });
              return 'confirmed';
            } catch (error) {
              if (error instanceof ApiError && error.status === 404) return 'missing';
              return 'unknown';
            }
          },
          onAccepted: () => {
            if (hasWorkspaceTaskLaunch && typeof sessionStorage !== 'undefined') {
              clearWorkspaceTaskLaunch(sessionStorage);
              if (user?.id) invalidateWorkspaceDashboard(user.id);
            }
            const current = useChatStore.getState();
            if (shouldAutoActivateCreatedSession({
              navigationVersionAtSend,
              createdProjectId: targetProjectId,
              currentActiveSessionId: current.activeSessionId,
              currentNavigationVersion: current.activeSessionOpenVersion,
              currentProjectId: current.currentProjectId,
            })) {
              setActiveSession(targetSessionId);
            }
          },
          discard: async () => {
            try {
              await deleteSession(targetSessionId);
            } catch (error) {
              if (!(error instanceof ApiError) || error.status !== 404) throw error;
            }
            removeSession(targetSessionId);
          },
        });
      } else {
        await sendMessage();
      }
      return true;
    } catch (error) {
      if (!isRunningFollowup) removeMessage(targetSessionId, messageId);
      throw error;
    }
  };

  const currentMessages = activeSessionId ? messages[activeSessionId] || [] : [];
  const activeMessageRegion = activeSessionId ? messageLoadBySession[activeSessionId] : undefined;
  useEffect(() => {
    if (!user || !activeSessionId || !activeMessageRegion || activeMessageRegion.revision === null) return;
    if (activeMessageRegion.dirty || activeMessageRegion.cacheSource !== 'network' || activeMessageRegion.status !== 'ready') return;
    if (cacheRevisionScheduledRef.current.get(activeSessionId) === activeMessageRegion.revision) return;
    cacheRevisionScheduledRef.current.set(activeSessionId, activeMessageRegion.revision);
    scheduleMessageCacheWrite(user.id, {
      sessionId: activeSessionId,
      revision: activeMessageRegion.revision,
      hasMore: activeMessageRegion.hasMore,
      nextCursor: activeMessageRegion.nextCursor,
      messages: currentMessages.slice(-MESSAGE_PAGE_SIZE).map(createCacheableMessageSummary),
    });
  }, [activeMessageRegion, activeSessionId, currentMessages, user]);
  const activeMessageRegionDirty = activeSessionId ? Boolean(messageLoadBySession[activeSessionId]?.dirty) : false;
  useEffect(() => {
    if (activeMessageRegionDirty) requestLatestMessagesRefresh();
  }, [activeMessageRegionDirty, requestLatestMessagesRefresh]);
  const selectableShareMessageIds = useMemo(() => getSelectableMessageIds(currentMessages), [currentMessages]);
  const normalizedSelectedShareIds = useMemo(
    () => normalizeSelectedMessageIds(currentMessages, selectedShareMessageIds),
    [currentMessages, selectedShareMessageIds],
  );
  useEffect(() => {
    setShareSelectionMode(false);
    setSelectedShareMessageIds(new Set());
    setShareDraft(null);
  }, [activeSessionId]);
  const handleLoadOlderMessages = useCallback(async () => {
    const sessionId = activeSessionId;
    if (!sessionId) return { loadedCount: 0, hasMore: false };

    const state = useChatStore.getState();
    const loadedMessages = state.messages[sessionId] || [];
    const region = state.messageLoadBySession[sessionId];
    if (!region?.hasMore || !region.nextCursor) return { loadedCount: 0, hasMore: false };
    try {
      const result = await getMessagePage(sessionId, { limit: MESSAGE_PAGE_SIZE, cursor: region.nextCursor });
      if (result.unchanged) return { loadedCount: 0, hasMore: false };
      const olderMessages = result.page.messages;
      prependMessages(sessionId, olderMessages);
      updateMessageRegion(sessionId, region.generation, {
        revision: result.page.revision,
        hasMore: result.page.hasMore,
        nextCursor: result.page.nextCursor,
        cacheSource: 'network',
      });
      const loadedIds = new Set(loadedMessages.map((message) => message.id));
      const loadedCount = olderMessages.filter((message) => !loadedIds.has(message.id)).length;
      return {
        loadedCount,
        hasMore: result.page.hasMore,
      };
    } catch (error) {
      console.error('加载更早消息失败', error);
      throw error;
    }
  }, [activeSessionId, prependMessages, updateMessageRegion]);
  const currentSession = sessions.find((s) => s.id === activeSessionId);
  const queuedTurn = useEngineConcurrencyStore((state) => activeSessionId ? state.queueBySessionId[activeSessionId] || null : null);
  const queuedResourceConcurrency = useEngineConcurrencyStore((state) => queuedTurn
    ? state.concurrencyByResourceKey[queuedTurn.resourceKey]
    : undefined);
  const draftSession = Boolean(currentSession && !currentSession.engine);
  const selectedEngine = currentSession?.engine ?? newSessionEngine;
  engineSelectionContextRef.current = `${activeSessionId}\0${activeSessionOpenVersion}\0${currentProjectId}\0${pendingProjectPath}`;
  const currentEngineStatus = selectedEngine
    ? engineStatuses.find((status) => status.id === selectedEngine)
    : undefined;
  const currentCapabilities = currentEngineStatus?.capabilities;
  const engineStatusNotice = currentSession?.engine
    ? engineStatusState === 'ready' && !currentEngineStatus?.available
      ? { message: currentEngineStatus?.message || '当前引擎不可用', tone: 'danger' as const, reason: '当前会话绑定的引擎状态显示不可用，暂时无法继续发送。', nextStep: '检查并恢复该引擎后重试；当前会话的引擎不能直接切换。' }
      : null
    : engineStatusState === 'loading'
      ? { message: '正在检查可用引擎…', tone: 'processing' as const, reason: '新会话正在获取各引擎的可用状态。', nextStep: '等待检查完成后选择可用引擎。' }
      : engineStatusState === 'error'
        ? { message: '无法获取引擎状态，请稍后重试', tone: 'danger' as const, reason: '引擎状态查询失败，暂时无法确认可发送的引擎。', nextStep: '稍后重新检查引擎状态。' }
        : selectedEngine && !currentEngineStatus?.available
          ? { message: currentEngineStatus?.message || '所选引擎当前不可用', tone: 'danger' as const, reason: '新会话当前选中的引擎状态显示不可用。', nextStep: '在输入框的引擎选择器中改选可用引擎，或等待该引擎恢复。' }
          : !engineStatuses.some((status) => status.available)
          ? { message: '当前没有可用的 AI 引擎', tone: 'danger' as const, reason: '本次状态检查没有发现可发送消息的引擎。', nextStep: '检查引擎维护状态，待至少一个引擎恢复后重试。' }
          : engineFallbackNotice
            ? { message: engineFallbackNotice, tone: 'warning' as const, reason: '账号默认引擎暂时不可用，新会话已临时选用其他可用引擎。', nextStep: '可以继续使用当前引擎，或在引擎选择器中重新选择。' }
            : null;
  const searchNavigationVisible = Boolean(
    activeSessionId
    && activeMatchSessionId === activeSessionId
    && searchMatches.length > 0
    && searchTargetMessageId,
  );
  const currentSearchMatch = currentSearchMatchIndex >= 0 ? searchMatches[currentSearchMatchIndex] : null;
  useEffect(() => {
    if (!activeSessionId || !currentSearchMatch || currentSearchMatch.scope === 'message') {
      searchDetailsRetryRef.current = null;
      return;
    }
    const target = (useChatStore.getState().messages[activeSessionId] || [])
      .find((message) => message.id === currentSearchMatch.messageId);
    if (!target || target.detailsLoaded || target.items || target.processContent || target.processTimeline) return;
    setSearchHistoryStatus('loading');
    void ensureMessageDetails(activeSessionId, currentSearchMatch.messageId).then(() => {
      searchDetailsRetryRef.current = null;
      setSearchHistoryStatus('idle');
    }).catch(() => {
      searchDetailsRetryRef.current = { sessionId: activeSessionId, messageId: currentSearchMatch.messageId };
      setSearchHistoryStatus('error');
    });
  }, [activeSessionId, currentSearchMatch, ensureMessageDetails]);
  // 只有当前会话就是发起流式的会话时，才显示流式内容（防止切换会话后串台）
  const isStreamingThisSession = streaming.streamingSessionId === activeSessionId;
  const latestReplyMissing = isLatestMessageReplyMissing(currentMessages);
  const allowSessionStatusRunningBubble = latestReplyMissing;
  const inputState = getSessionInputState(
    latestReplyMissing ? currentSession?.status : undefined,
    streaming,
    activeSessionId,
  );
  const queuedTurnUi = resolveQueuedTurnUiState(queuedTurn, inputState.isQueued, {
    probeInProgress: queuedResourceConcurrency?.probeInProgress,
  });
  const isCancellingQueuedTurn = cancellingQueuedSessionId === activeSessionId;
  useEffect(() => {
    if (!queuedTurnUi.isQueued && isCancellingQueuedTurn) setCancellingQueuedSessionId(null);
  }, [isCancellingQueuedTurn, queuedTurnUi.isQueued]);
  const handleCancelQueuedTurn = useCallback(async () => {
    if (!activeSessionId || isCancellingQueuedTurn) return;
    const sessionId = activeSessionId;
    setCancellingQueuedSessionId(sessionId);
    try {
      await cancelQueuedTurn(sessionId);
    } catch (error) {
      setCancellingQueuedSessionId((current) => current === sessionId ? null : current);
      setError(error instanceof Error ? error.message : '取消排队失败', sessionId);
    }
  }, [activeSessionId, isCancellingQueuedTurn, setError]);
  const isCurrentSessionRunning = isSessionRunning(streaming, activeSessionId) || inputState.isRunning;
  const suggestedReply = useMemo(
    () => selectSuggestedReplyCandidate(currentMessages, isCurrentSessionRunning),
    [currentMessages, isCurrentSessionRunning],
  );
  const latestMessagesBubbleStatus = getLatestMessageBubbleStatus(
    latestMessagesRefreshStatus,
    latestMessagesRefreshVisible,
    isCurrentSessionRunning,
    latestReplyMissing,
  );
  useEffect(() => {
    if (!activeSessionId || typeof navigator !== 'undefined' && !navigator.onLine) return;
    const latestAssistant = [...currentMessages].reverse().find((message) => message.role === 'assistant' && message.hasDetails && !message.detailsLoaded);
    if (!latestAssistant) return;
    const run = () => { void ensureMessageDetails(activeSessionId, latestAssistant.id).catch(() => undefined); };
    if ('requestIdleCallback' in window) {
      const idleId = window.requestIdleCallback(run, { timeout: 2_000 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timer = globalThis.setTimeout(run, 250);
    return () => globalThis.clearTimeout(timer);
  }, [activeSessionId, currentMessages, ensureMessageDetails]);
  const hasMessages = currentMessages.length > 0
    || Boolean(activeSessionId && operationErrorsBySession[activeSessionId])
    || isCurrentSessionRunning
    || latestMessagesBubbleStatus !== 'idle'
    || (isStreamingThisSession && !!streaming.errorMessage);
  const chatInitializationState = getChatInitializationState({
    navigationStatus: navigationLoadState.status,
    activeSessionId,
    messageStatus: activeSessionId ? (messageLoadBySession[activeSessionId]?.status ?? 'idle') : 'idle',
    hasMessages,
  });
  const managementBrowseEmpty = user?.role === 'admin' && sidebarAccountScope === 'all' && !activeSessionId;

  useEffect(() => {
    const pending = messageRefreshPendingRef.current;
    if (!activeSessionId || !pending || pending.sessionId !== activeSessionId) return;
    const state = useChatStore.getState();
    if (!Object.prototype.hasOwnProperty.call(state.messages, activeSessionId)) return;
    if (state.messages[activeSessionId] === pending.baseline) return;
    completeLatestMessagesRefresh(activeSessionId, pending.generation);
  }, [activeSessionId, completeLatestMessagesRefresh, currentMessages]);

  // 右侧面板
  const { panelVisible, toggleRightPanel } = useChatStore();

  // 当前会话的项目信息
  const currentProject = currentSession ? projects.find((p) => p.id === currentSession.project_id) : null;
  const titleMenuInteractionPolicy = getSidebarAccountInteractionPolicy(
    user?.role === 'admin' ? sidebarAccountScope : 'mine',
    user?.id ?? '',
    currentSession?.owner,
  );

  // 标题菜单操作
  const handleTitlePin = () => {
    if (!currentSession || !titleMenuInteractionPolicy.canOrganize) return;
    const newPinned = currentSession.pinned ? 0 : 1;
    void updateSessionRequest(currentSession.id, { pinned: newPinned })
      .then(() => updateSessionPinned(currentSession.id, !!newPinned))
      .catch((error) => setError(error.message || '更新会话失败'));
    setTitleMenuAnchor(null);
  };

  const handleTitleRenameStart = () => {
    if (!currentSession) return;
    setRenameVal(currentSession.title);
    setRenaming(true);
    setTitleMenuAnchor(null);
  };

  const handleTitleRenameSubmit = () => {
    if (!currentSession || !renaming) return;
    const title = renameVal.trim();
    if (title) {
      void updateSessionRequest(currentSession.id, { title })
        .then(() => updateSessionTitle(currentSession.id, title))
        .catch((error) => setError(error.message || '重命名会话失败'));
    }
    setRenaming(false);
  };

  const handleTitleDelete = () => {
    if (!currentSession || isSessionActionInProgress(currentSession.status)) return;
    beginDelete(currentSession.id);
    const target = { id: currentSession.id, title: currentSession.title, impact: null, impactStatus: 'loading' as const };
    setDeleteTarget(target);
    void getSessionDeletionImpact(target.id)
      .then((impact) => setDeleteTarget((current) => current?.id === target.id ? { ...current, impact, impactStatus: 'ready' } : current))
      .catch(() => setDeleteTarget((current) => current?.id === target.id ? { ...current, impact: null, impactStatus: 'unavailable' } : current));
    setTitleMenuAnchor(null);
  };

  const handleTitleCopyId = async () => {
    if (!currentSession) return;
    try {
      await copyToClipboard(currentSession.id);
    } catch {
      setError('复制会话 ID 失败');
    }
  };

  const handleTitleUnarchive = async () => {
    if (!currentSession) return;
    try {
      const result = await unarchiveSession(currentSession.id);
      updateSession(result.session);
    } catch (error) {
      setError(error instanceof Error ? error.message : '取消归档失败');
    }
  };

  const requestCreateSessionFromContext = (messageId?: string) => {
    if (!currentSession || forkingTarget) return;
    setTitleMenuAnchor(null);
    setCreateSessionTarget({
      sourceSessionId: currentSession.id,
      sourceTitle: currentSession.title,
      ...(messageId ? { messageId } : {}),
    });
  };

  const confirmCreateSessionFromContext = async () => {
    if (!createSessionTarget || forkingTarget) return;
    const target = createSessionTarget;
    setForkingTarget(target.messageId || 'tail');
    try {
      const result = await forkSession(target.sourceSessionId, target.messageId);
      addSession(result.session);
      setActiveSession(result.session.id);
    } catch (error) {
      setError(error instanceof Error ? error.message : '创建新会话失败', target.sourceSessionId);
    } finally {
      setForkingTarget(null);
      setCreateSessionTarget(null);
    }
  };

  const openShareDraft = (scope: ShareDraft['scope'], messageIds?: string[]) => {
    if (!currentSession) return;
    if (selectableShareMessageIds.size === 0) {
      setTitleMenuAnchor(null);
      setShareUnavailableOpen(true);
      return;
    }
    if (shareDraft?.sessionId === currentSession.id && shareDraft.scope === scope && restoreMinimizedPanel('share-create-title')) { setTitleMenuAnchor(null); return; }
    setShareDraft({ sessionId: currentSession.id, scope, messageIds, defaultTitle: currentSession.title });
    setTitleMenuAnchor(null);
  };

  const toggleShareSelection = (messageId: string) => {
    if (!selectableShareMessageIds.has(messageId)) return;
    setSelectedShareMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId); else next.add(messageId);
      return next;
    });
  };

  const titleMenuItems = currentSession ? createSessionMenuItems({
    session: currentSession,
    capabilities: currentCapabilities,
    onPin: titleMenuInteractionPolicy.canOrganize ? handleTitlePin : undefined,
    onDetails: () => setMobileDetailsOpen(true),
    onRename: handleTitleRenameStart,
    renameLabel: titleMenuInteractionPolicy.renameLabel,
    onCopyId: handleTitleCopyId,
    onFork: currentSession.can_fork ? () => requestCreateSessionFromContext() : undefined,
    forkPending: forkingTarget === 'tail',
    onSelectMessages: () => {
      if (selectableShareMessageIds.size === 0) {
        setTitleMenuAnchor(null);
        setShareUnavailableOpen(true);
        return;
      }
      setShareSelectionMode(true);
      setSelectedShareMessageIds(new Set());
      setTitleMenuAnchor(null);
    },
    onShareSession: () => openShareDraft('session'),
    onUnarchive: currentSession.codex_archived ? handleTitleUnarchive : undefined,
    onDelete: handleTitleDelete,
  }) : [];

  const currentSessionDetails = currentSession ? (
    <SessionDetailsContent
      session={currentSession}
      project={currentProject ?? null}
      status={getDisplayedSessionStatus(currentSession.status)}
    />
  ) : null;

  return (
    <div className="flex flex-col h-full min-h-0 relative overflow-hidden">
      <ChatViewHeaderRegion
        setActiveSession={setActiveSession}
        respondToInteraction={respondToInteraction}
        headerProps={{
          sidebarOpen,
          onToggleSidebar: toggleSidebar,
          currentSearchOpen,
          activeSessionId,
          currentSession,
          sessionDetails: currentSessionDetails,
          titleLoadState: activeSessionId ? sessionSummaryLoadById[activeSessionId] : undefined,
          onRetryTitle: () => setSessionSummaryReloadVersion((value) => value + 1),
          isMobile,
          renaming,
          renameValue: renameVal,
          onRenameChange: setRenameVal,
          onRenameSubmit: handleTitleRenameSubmit,
          onRenameCancel: () => setRenaming(false),
          titleMenuOpen: titleMenuAnchor !== null,
          onToggleTitleMenu: setTitleMenuAnchor,
          wideLayout,
          onToggleWideLayout: () => setWideLayout((value) => !value),
          panelVisible,
          onToggleRightPanel: toggleRightPanel,
        }}
        search={{
          query: currentSearchInput,
          status: searchStatus,
          error: searchError,
          historyStatus: searchHistoryStatus,
          currentIndex: currentSearchMatchIndex,
          loadedMatchCount: searchMatches.length,
          totalMatches: totalSearchMatches,
          truncated: searchMatchesTruncated,
          includeProcess: includeProcessSearch,
          includeOperations: includeOperationsSearch,
          mobile: isMobile,
          onOpen: () => setCurrentSearchOpen(true),
          onQueryChange: setCurrentSearchInput,
          onIncludeProcessChange: setIncludeProcessSearch,
          onIncludeOperationsChange: setIncludeOperationsSearch,
          onPrevious: () => navigateSearchMatch('previous'),
          onNext: () => navigateSearchMatch('next'),
          onRetry: () => runCurrentSearch(currentSearchInput),
          onRetryHistory: retrySearchHistoryLoad,
          onInputFocusChange: setSearchInputFocused,
          onClose: closeCurrentSearch,
        }}
        titleMenuProps={{
          open: titleMenuAnchor !== null && Boolean(currentSession),
          anchorRect: titleMenuAnchor,
          items: titleMenuItems,
          onClose: closeTitleMenu,
          mobile: isMobile,
          label: '会话操作菜单',
        }}
        mismatch={protocolMismatch}
        connectionError={connectionError}
        onReconnect={reconnect}
      />

      {managementBrowseEmpty ? <div role="status" className="flex flex-1 items-center justify-center px-6 py-10 text-center"><div><div className="text-sm font-medium text-[var(--color-text)]">请选择一个会话</div><div className="mt-1 text-xs text-[var(--color-text-secondary)]">请从左侧选择会话查看或协助处理；用户资源视图不创建新会话。</div></div></div> : <ChatViewMessageRegion
        chatInitializationState={chatInitializationState}
        hasMessages={hasMessages}
        isAdmin={user?.role === 'admin'}
        recentSession={selectRecentSession(sessions, activeSessionId, user?.role === 'admin' ? user.id : undefined)}
        onOpenRecentSession={setActiveSession}
        messageListKey={activeSessionId}
        messageError={activeSessionId ? messageLoadBySession[activeSessionId]?.error : null}
        onRetry={requestLatestMessagesRefresh}
        messageListProps={{
          sessionId: activeSessionId || undefined,
          engine: selectedEngine,
          knownProjects: projects,
          projectName: currentProject?.name,
          followups: activeSessionId ? followupsBySession[activeSessionId] : undefined,
          messages: currentMessages,
          projectPath: currentProject?.path,
          mobile: isMobile,
          wideLayout,
          streamingContent: isStreamingThisSession && streaming.isStreaming ? streaming.currentContent : '',
          streamingProcessContent: isStreamingThisSession && streaming.isStreaming ? streaming.processContent : '',
          hasOlderMessages: activeSessionId ? Boolean(messageLoadBySession[activeSessionId]?.hasMore) : false,
          onLoadOlder: handleLoadOlderMessages,
          isWaiting: (isStreamingThisSession && streaming.isWaiting) || (allowSessionStatusRunningBubble && currentSession?.status === 'pending'),
          waitingStage: isStreamingThisSession
            ? streaming.waitingStage
            : (currentSession?.status === 'processing' || currentSession?.status === 'recovering' ? 'started' : 'submitted'),
          isStreaming: (isStreamingThisSession && streaming.isStreaming) || (allowSessionStatusRunningBubble && (currentSession?.status === 'processing' || currentSession?.status === 'recovering' || currentSession?.status === 'awaiting_action' || currentSession?.status === 'stopping')),
          isStopping: (isStreamingThisSession && streaming.isStopping) || (allowSessionStatusRunningBubble && currentSession?.status === 'stopping'),
          isAwaitingAction: allowSessionStatusRunningBubble && currentSession?.status === 'awaiting_action',
          pendingActionKind: currentSession?.pending_action_kind,
          isRecovering: allowSessionStatusRunningBubble && currentSession?.status === 'recovering',
          errorMessage: isStreamingThisSession ? streaming.errorMessage : null,
          operationErrorMessage: activeSessionId ? operationErrorsBySession[activeSessionId] : undefined,
          streamingStartTime: isStreamingThisSession ? streaming.startTime : null,
          streamingSteps: isStreamingThisSession ? streaming.processSteps : undefined,
          streamingBlocks: isStreamingThisSession ? streaming.blocks : undefined,
          streamingProcessTimeline: isStreamingThisSession ? streaming.processTimeline : undefined,
          streamingTokenUsage: currentCapabilities?.tokenUsage && isStreamingThisSession ? streaming.tokenUsage || undefined : undefined,
          // 授权按钮仅会话所有人可操作；有查看权限的项目成员只读，不传处理器即隐藏操作按钮
          ...(currentSession?.owner && currentSession.owner.id === user?.id ? {
            canAnswerAsyncQuestion: true,
            onAsyncQuestionAnswer: async (questionId: string, answer: string) => {
              if (!activeSessionId) throw new Error('当前会话不存在');
              const sent = await handleSend(answer, [], generateUUID(), undefined, undefined, questionId);
              if (!sent) throw new Error('提交失败，请重试');
            },
            onInteractionRespond: (interactionId: string, action: RespondInteractionCommand['action'], options?: { answers?: Record<string, string[]>; formData?: Record<string, unknown> }) => {
              if (!activeSessionId) return Promise.reject(new Error('当前会话不存在'));
              return respondToInteraction(activeSessionId, interactionId, action, options);
            },
          } : {}),
          onResync: () => activeSessionId && resyncSession(activeSessionId),
          latestMessagesRefreshStatus: latestMessagesBubbleStatus,
          onRetryLatestMessages: requestLatestMessagesRefresh,
          onLoadMessageDetails: (messageId) => activeSessionId
            ? ensureMessageDetails(activeSessionId, messageId)
            : Promise.reject(new Error('当前会话不存在')),
          shareSelectionMode,
          selectableMessageIds: selectableShareMessageIds,
          selectedMessageIds: selectedShareMessageIds,
          onToggleShareSelection: toggleShareSelection,
          onShareMessage: (messageId) => openShareDraft('single', [messageId]),
          onForkMessage: currentSession?.can_fork
            ? (messageId) => requestCreateSessionFromContext(messageId)
            : undefined,
          forkingMessageId: forkingTarget === 'tail' ? null : forkingTarget,
          searchTargetMessageId: searchNavigationVisible ? searchTargetMessageId : null,
          searchQuery: searchNavigationVisible ? searchQuery : '',
          searchTargetScope: searchNavigationVisible ? currentSearchMatch?.scope : undefined,
          searchTargetItemId: searchNavigationVisible ? currentSearchMatch?.itemId : undefined,
        }}
      />}
      {!managementBrowseEmpty && activeSessionId && <SessionFollowupStatus
        followups={followupsBySession[activeSessionId] || []}
        onCancel={(messageId) => { try { cancelFollowup(activeSessionId, messageId); } catch (error) { setError(error instanceof Error ? error.message : '取消失败'); } }}
        onResume={() => { try { resumeFollowups(activeSessionId); } catch (error) { setError(error instanceof Error ? error.message : '继续失败'); } }}
      />}
      {!managementBrowseEmpty && <ChatViewComposerRegion
        shareSelectionMode={shareSelectionMode}
        shareSelectionProps={{
          count: normalizedSelectedShareIds.length,
          onCancel: () => { setShareSelectionMode(false); setSelectedShareMessageIds(new Set()); },
          onNext: () => openShareDraft('selection', normalizedSelectedShareIds),
        }}
        keepComposerBehindSearchKeyboard={keepComposerBehindSearchKeyboard}
        chatInputProps={{
          onSend: handleSend,
          onEnsureProject: () => ensureProjectForInput(false),
          onStop: () => { if (activeSessionId) cancel(activeSessionId); },
          onCancelQueued: () => { void handleCancelQueuedTurn(); },
          sessionId: activeSessionId,
          isStreaming: isCurrentSessionRunning,
          isStopping: inputState.isStopping,
          isAwaitingAction: latestReplyMissing && currentSession?.status === 'awaiting_action',
          canRespondToInteraction: currentSession?.owner?.id === user?.id,
          isQueued: queuedTurnUi.isQueued,
          isQueueWaiting: queuedTurnUi.isWaiting,
          isCancellingQueued: isCancellingQueuedTurn,
          projectName: currentProject?.name,
          selectedEngine,
          engineStatuses,
          engineLocked: !draftSession && Boolean(currentSession?.engine),
          engineFallbackNotice,
          onEngineChange: (engine) => {
            const intent = engineSelectionContextRef.current;
            return () => {
              if (intent !== engineSelectionContextRef.current) return;
              engineSelectionContextRef.current = '';
              setNewSessionEngine(engine);
              setEngineFallbackNotice(null);
            };
          },
          onEngineStatusesChange: applyEngineStatusSnapshot,
          engineStatusNotice,
          tokenUsageAvailable: Boolean(currentSession && currentCapabilities?.tokenUsage),
          wideLayout,
          suggestedReply,
          focusRequest: composerFocusRequest,
          registerComposerFocusHandler,
        }}
      />}

      <ChatViewDialogs
        shareDraft={shareDraft}
        onCloseShare={() => { setShareDraft(null); if (shareSelectionMode) { setShareSelectionMode(false); setSelectedShareMessageIds(new Set()); } }}
        shareUnavailableOpen={shareUnavailableOpen}
        onCloseShareUnavailable={() => setShareUnavailableOpen(false)}
        mobileDetailsOpen={mobileDetailsOpen}
        hasCurrentSession={Boolean(currentSession)}
        currentSessionDetails={currentSessionDetails}
        onCloseMobileDetails={() => setMobileDetailsOpen(false)}
        deleteTarget={deleteTarget}
        onCancelDelete={cancelDelete}
        onConfirmDelete={confirmDelete}
        deletePendingLabel={deletePendingLabel}
        createSessionTarget={createSessionTarget ? {
          sourceTitle: createSessionTarget.sourceTitle,
          fromReply: Boolean(createSessionTarget.messageId),
        } : null}
        onCancelCreateSession={() => setCreateSessionTarget(null)}
        onConfirmCreateSession={confirmCreateSessionFromContext}
      />
      <TrashProjectRecoveryDialog recovery={trashProjectRecovery} />
    </div>
  );
}
