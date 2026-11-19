import { create } from 'zustand';
import { tracker } from '../analytics/tracker.ts';
import type {
  ArchivePreviewDto,
  MessageDto,
  MessageSummaryDto,
  ProcessItemDto,
  ProcessItemStatus,
  ProcessTimelineEntryDto,
  ProjectDto,
  SessionDto,
  SessionStatus as RelaySessionStatus,
  SidebarOrderDto,
  PdfDocumentPreviewDto,
  SpreadsheetDocumentPreviewDto,
  TokenUsageDto,
  WordDocumentPreviewDto,
} from '../generated/relay-contracts';
import type { WaitingStage } from '../utils/waiting-status.ts';
import { generateUUID } from '../utils/uuid.ts';
import { getInitialChatCandidate, storeEmptyChatLocation, storeSessionChatLocation } from './chat-location.ts';
import { readStoredRightPanelWidth } from '../utils/right-panel-width.ts';
import { upsertProcessStep } from './process-steps.ts';
import { appendNarrativeDelta, insertOperationReference, isProcessTimelineOperationType } from './process-timeline.ts';
import { isDesktopSidebarViewport } from '../utils/sidebar-responsive.ts';
import { getMessageRevisionDisposition, mergeMessagesById } from './message-snapshot.ts';
import {
  beginRegionLoad,
  commitRegionError,
  commitRegionReady,
  createMessageRegionLoadState,
  createRegionLoadState,
  type MessageRegionLoadState,
  type RegionLoadState,
} from './region-load-state.ts';
import { disposeFilePreviewTab } from '../components/layout/file-preview-request-manager.ts';
import type { FileMetadataResult } from '../api/filesystem.ts';
import { mergeSessionByPreferencesRevision } from './engine-models.ts';
import { isAssistantTerminalMessage } from './message-terminal.ts';
import { useSessionOperationErrorStore } from './session-operation-errors.ts';

export type Project = ProjectDto;
export type Session = SessionDto;
export type SessionStatus = RelaySessionStatus;
export type HtmlPreviewMode = 'source' | 'visualization';
export type SidebarAccountScope = 'mine' | 'all';

export type Message = MessageDto
  & Partial<Pick<MessageSummaryDto, 'hasDetails' | 'processItemCount' | 'processNarrativeCount' | 'changedFileCount' | 'asyncQuestionIds' | 'historicalOperationRecord'>>
  & { detailsLoaded?: boolean; deferredMarkdown?: boolean };
export type ProcessStep = ProcessItemDto;
export type ProcessStepStatus = ProcessItemStatus;
export type ProcessTimelineEntry = ProcessTimelineEntryDto;

export interface ProtocolMismatch {
  clientVersion: number;
  serverVersion: number | null;
}

/** 流式内容块 —— text 和 step 交错排列 */
export interface StreamingBlock {
  type: 'text' | 'step';
  content?: string;  // text block 的内容
  step?: ProcessStep; // step block
}

/** 右侧面板 tab 项 */
export type RightPanelDocumentPreview =
  | ArchivePreviewDto
  | (PdfDocumentPreviewDto & { previewUrl: string })
  | WordDocumentPreviewDto
  | SpreadsheetDocumentPreviewDto;

export interface RightPanelTab {
  id: string;
  title: string;
  content: string;
  contentSize?: number;
  textPreviewTruncated?: boolean;
  textPreviewTruncationReason?: 'file-size' | 'output-size';
  language?: string;
  isImage?: boolean;
  imageUrl?: string;
  loading?: boolean;
  previewError?: string;
  sourcePath?: string;
  forceAccessAvailable?: boolean;
  fileAccessToken?: string;
  compressedPreviewAvailable?: boolean;
  documentPreview?: RightPanelDocumentPreview;
  mediaPreview?: { kind: 'audio' | 'video'; previewUrl: string };
  fileMetadata?: FileMetadataResult;
  fileMetadataLoading?: boolean;
  fileMetadataError?: string | { message: string; code?: string; status?: number };
  htmlPreviewMode?: HtmlPreviewMode;
  previewView?: 'preview' | 'source' | 'git-diff';
  htmlPreviewScriptsEnabled?: boolean;
}

type RightPanelContentUpdate = Partial<Omit<RightPanelTab, 'id' | 'title'>>;

export interface StreamingState {
  isWaiting: boolean;
  waitingStage: WaitingStage;
  isStreaming: boolean;
  isStopping: boolean;
  currentContent: string;
  processContent: string;
  currentPhase: string | null;
  startTime: number | null;
  errorMessage: string | null;
  processSteps: ProcessStep[];
  processTimeline: ProcessTimelineEntry[];
  streamingSessionId: string | null; // 发送时的 sessionId，防止切换会话后串台
  blocks: StreamingBlock[]; // 有序内容块（text + step 交错）
  tokenUsage: TokenUsageDto | null;
}

export interface RuntimeStreamingSnapshot {
  sessionId: string;
  startTime: number | null;
  waitingStage: StreamingState['waitingStage'];
  isStreaming: boolean;
  isStopping: boolean;
  currentContent: string;
  processContent: string;
  processSteps: ProcessStep[];
  processTimeline: ProcessTimelineEntry[];
}

interface ChatStore {
  // Projects
  projects: Project[];
  currentProjectId: string | null;
  pendingProjectPath: string | null; // 用户选择了目录但还没创建项目，等首条消息时创建
  setProjects: (projects: Project[]) => void;
  setCurrentProject: (id: string) => void;
  addProject: (project: Project) => void;
  upsertProject: (project: Project) => void;
  setPendingProject: (path: string | null) => void;
  removeProject: (id: string) => void;
  updateProjectName: (id: string, name: string) => void;
  updateProjectPinned: (id: string, pinned: boolean) => void;
  sidebarOrders: Record<string, SidebarOrderDto>;
  sidebarOrderVersions: Record<string, number>;
  setSidebarOrders: (orders: SidebarOrderDto[]) => void;
  setSidebarOrder: (order: SidebarOrderDto) => void;

  // Sessions
  sessions: Session[];
  activeSessionId: string | null;
  // 本地/URL 位置尚未由服务端确认时，不允许触发会话内容加载。
  pendingRestoreSessionId: string | null;
  activeSessionOpenVersion: number;
  autoOpenProjectPicker: boolean;
  projectSelectionLocked: boolean;
  navigationLoadState: RegionLoadState;
  sessionSummaryLoadById: Record<string, RegionLoadState>;
  messageLoadBySession: Record<string, MessageRegionLoadState>;
  setSessions: (sessions: Session[]) => void;
  mergeReconnectSessionSnapshot: (
    sessions: Session[],
    expectedStatuses: Record<string, SessionStatus | undefined>,
  ) => void;
  setActiveSession: (id: string, options?: { autoOpenProjectPicker?: boolean; projectSelectionLocked?: boolean }) => void;
  restoreStoredChatCandidate: () => void;
  resetAuthenticatedChatState: () => void;
  beginNavigationLoad: () => number;
  completeNavigationLoad: (generation: number) => void;
  failNavigationLoad: (generation: number, error: string) => void;
  beginSessionSummaryLoad: (sessionId: string) => number;
  completeSessionSummaryLoad: (sessionId: string, generation: number) => void;
  failSessionSummaryLoad: (sessionId: string, generation: number, error: string) => void;
  beginMessageLoad: (sessionId: string) => number;
  completeMessageLoad: (sessionId: string, generation: number) => void;
  failMessageLoad: (sessionId: string, generation: number, error: string) => void;
  updateMessageRegion: (
    sessionId: string,
    generation: number,
    updates: Partial<Omit<MessageRegionLoadState, 'generation'>>,
  ) => void;
  applyMessageSync: (
    sessionId: string,
    messages: Message[],
    revision: number,
    hasMore: boolean,
    nextCursor: MessageRegionLoadState['nextCursor'],
  ) => void;
  applyMessageSaved: (sessionId: string, message: Message, revision: number, settleStreaming?: boolean) => void;
  addSession: (session: Session) => void;
  upsertSession: (session: Session) => void;
  ensureSession: (session: Session) => void;
  updateSessionPinned: (id: string, pinned: boolean) => void;
  updateSessionTitle: (id: string, title: string) => void;
  updateSession: (session: Partial<Session> & Pick<Session, 'id'>) => void;
  updateSessionStatus: (id: string, status: SessionStatus) => void;
  removeSession: (id: string) => void;

  // Messages
  messages: Record<string, Message[]>;
  setMessages: (sessionId: string, messages: Message[]) => void;
  mergeMessages: (sessionId: string, messages: Message[]) => void;
  addMessage: (sessionId: string, message: Message) => void;
  removeMessage: (sessionId: string, messageId: string) => void;
  prependMessages: (sessionId: string, messages: Message[]) => void;

  // Streaming
  streaming: StreamingState;
  applyRuntimeStreamingSnapshot: (snapshot: RuntimeStreamingSnapshot) => void;
  startWaiting: (startTime?: number | null, stage?: StreamingState['waitingStage']) => void;
  markRequestForwarded: () => void;
  startStreaming: () => void;
  startStopping: () => void;
  appendDelta: (content: string, phase?: string, itemId?: string, observedAt?: number) => void;
  addProcessStep: (item: ProcessStep) => void;
  updateProcessStep: (item: ProcessStep) => void;
  setProcessTimeline: (timeline: ProcessTimelineEntry[]) => void;
  setStreamingSessionId: (id: string) => void;
  setStreamingTokenUsage: (usage: TokenUsageDto) => void;
  finishStreaming: () => void;
  setError: (message: string, sessionId?: string) => void;
  setNonTerminalError: (message: string, sessionId?: string) => void;

  // UI
  sidebarOpen: boolean;
  sidebarAccountScope: SidebarAccountScope;
  connectionError: string | null;
  protocolMismatch: ProtocolMismatch | null;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarAccountScope: (scope: SidebarAccountScope) => void;
  setConnectionError: (message: string | null) => void;
  setProtocolMismatch: (mismatch: ProtocolMismatch | null) => void;

  // Context usage（按会话保存 Codex 真实数据；缺失时 UI 使用明确标注的本地估算）
  tokenUsageBySession: Record<string, TokenUsageDto>;
  setTokenUsage: (sessionId: string, usage: TokenUsageDto) => void;

  // Right Panel — 选项卡式文件预览
  rightPanelTabs: RightPanelTab[];
  activeTabId: string | null;
  prevActiveTabId: string | null;
  rightPanelWidth: number;
  panelVisible: boolean;
  rightPanelPinned: boolean;
  openRightPanel: (params: { title: string } & RightPanelContentUpdate) => string;
  closeRightPanel: () => void;
  closeRightPanelTab: (tabId: string) => void;
  closeAllRightPanelTabs: () => void;
  hideRightPanel: () => void;
  setActiveTabId: (id: string) => void;
  updateRightPanelTab: (tabId: string, params: RightPanelContentUpdate) => boolean;
  setRightPanelWidth: (width: number) => void;
  toggleRightPanelPinned: () => void;
  toggleRightPanel: () => void;
}

const initialChatCandidate = getInitialChatCandidate();

export const useChatStore = create<ChatStore>((set, get) => ({
  projects: [],
  currentProjectId: initialChatCandidate.currentProjectId,
  pendingProjectPath: null,
  setProjects: (projects) => set({ projects }),
  setCurrentProject: (id) => {
    const state = get();
    if (!state.activeSessionId && !state.pendingRestoreSessionId) storeEmptyChatLocation(id || null, undefined, state.autoOpenProjectPicker, state.projectSelectionLocked);
    set({ currentProjectId: id, pendingProjectPath: null });
  },
  addProject: (project) => set((state) => ({
    projects: state.projects.some((item) => item.id === project.id)
      ? state.projects.map((item) => item.id === project.id ? { ...item, ...project } : item)
      : [...state.projects, project],
  })),
  upsertProject: (project) => set((state) => ({
    projects: state.projects.some((item) => item.id === project.id)
      ? state.projects.map((item) => item.id === project.id ? { ...item, ...project } : item)
      : [...state.projects, project],
  })),
  setPendingProject: (path) => {
    const state = get();
    if (!state.activeSessionId) storeEmptyChatLocation(null, undefined, state.autoOpenProjectPicker, state.projectSelectionLocked);
    set({ pendingProjectPath: path, currentProjectId: null });
  },
  removeProject: (id) => {
    const state = get();
    const removedSessionIds = new Set(state.sessions.filter((session) => session.project_id === id).map((session) => session.id));
    const removingActiveSession = Boolean(state.activeSessionId && removedSessionIds.has(state.activeSessionId));
    const removingCurrentProject = state.currentProjectId === id;
    const remainingProjects = state.projects.filter((project) => project.id !== id);
    const activeProjectId = state.sessions.find((session) => session.id === state.activeSessionId)?.project_id ?? null;
    const nextProjectId = removingCurrentProject
      ? (!removingActiveSession && activeProjectId) || remainingProjects[0]?.id || null
      : state.currentProjectId;
    if (removingActiveSession) {
      for (const tab of state.rightPanelTabs) disposeFilePreviewTab(tab);
    }
    if (removingActiveSession || (removingCurrentProject && !state.activeSessionId)) {
      storeEmptyChatLocation(nextProjectId, undefined, false);
    }
    set((current) => ({
      projects: current.projects.filter((project) => project.id !== id),
      sessions: current.sessions.filter((session) => session.project_id !== id),
      ...(removingCurrentProject ? {
        currentProjectId: nextProjectId,
        pendingProjectPath: null,
        projectSelectionLocked: false,
      } : {}),
      ...(removingActiveSession ? {
        activeSessionId: '',
        activeSessionOpenVersion: current.activeSessionOpenVersion + 1,
        autoOpenProjectPicker: false,
        projectSelectionLocked: false,
        currentProjectId: nextProjectId,
        pendingProjectPath: null,
        rightPanelTabs: [],
        activeTabId: null,
        prevActiveTabId: null,
        panelVisible: false,
        rightPanelPinned: false,
      } : {}),
    }));
  },
  updateProjectName: (id, name) => set((state) => ({
    projects: state.projects.map((p) => p.id === id ? { ...p, name } : p),
  })),
  updateProjectPinned: (id, pinned) => set((state) => ({
    projects: state.projects.map((project) => project.id === id ? { ...project, pinned: pinned ? 1 : 0 } : project),
  })),
  sidebarOrders: {},
  sidebarOrderVersions: {},
  setSidebarOrders: (orders) => set((state) => ({
    sidebarOrders: Object.fromEntries(orders.map((order) => [order.scope, order])),
    sidebarOrderVersions: orders.reduce<Record<string, number>>((versions, order) => {
      versions[order.scope] = (state.sidebarOrderVersions[order.scope] ?? 0) + 1;
      return versions;
    }, { ...state.sidebarOrderVersions }),
  })),
  setSidebarOrder: (order) => set((state) => ({
    sidebarOrders: { ...state.sidebarOrders, [order.scope]: order },
    sidebarOrderVersions: {
      ...state.sidebarOrderVersions,
      [order.scope]: (state.sidebarOrderVersions[order.scope] ?? 0) + 1,
    },
  })),

  sessions: [],
  activeSessionId: null,
  pendingRestoreSessionId: initialChatCandidate.activeSessionId,
  activeSessionOpenVersion: 0,
  autoOpenProjectPicker: initialChatCandidate.autoOpenProjectPicker,
  projectSelectionLocked: initialChatCandidate.projectSelectionLocked === true,
  navigationLoadState: createRegionLoadState(),
  sessionSummaryLoadById: {},
  messageLoadBySession: {},
  setSessions: (sessions) => set((state) => ({
    sessions: sessions.map((session) => {
      const current = state.sessions.find((candidate) => candidate.id === session.id);
      return current ? mergeSessionByPreferencesRevision(current, session) : session;
    }),
  })),
  mergeReconnectSessionSnapshot: (sessions, expectedStatuses) => set((state) => {
    const currentById = new Map(state.sessions.map((session) => [session.id, session]));
    const merged = sessions.map((session) => {
      const current = currentById.get(session.id);
      if (!current) return session;
      currentById.delete(session.id);
      const statusWasUnchanged = Object.prototype.hasOwnProperty.call(expectedStatuses, session.id)
        && current.status === expectedStatuses[session.id];
      return mergeSessionByPreferencesRevision(current, {
        ...session,
        status: statusWasUnchanged ? session.status : current.status,
      });
    });
    return { sessions: [...merged, ...currentById.values()] };
  }),
  restoreStoredChatCandidate: () => {
    const candidate = getInitialChatCandidate();
    set((state) => ({
      activeSessionId: null,
      pendingRestoreSessionId: candidate.activeSessionId,
      currentProjectId: candidate.currentProjectId,
      activeSessionOpenVersion: state.activeSessionOpenVersion + (state.activeSessionId ? 1 : 0),
      autoOpenProjectPicker: candidate.autoOpenProjectPicker,
      projectSelectionLocked: candidate.projectSelectionLocked === true,
      navigationLoadState: createRegionLoadState(),
      sessionSummaryLoadById: {},
      messageLoadBySession: {},
    }));
  },
  resetAuthenticatedChatState: () => {
    for (const tab of get().rightPanelTabs) disposeFilePreviewTab(tab);
    set({
      projects: [],
      currentProjectId: null,
      pendingProjectPath: null,
      sessions: [],
      activeSessionId: null,
      pendingRestoreSessionId: null,
      activeSessionOpenVersion: 0,
      autoOpenProjectPicker: true,
      projectSelectionLocked: false,
      navigationLoadState: createRegionLoadState(),
      sessionSummaryLoadById: {},
      messageLoadBySession: {},
      messages: {},
      tokenUsageBySession: {},
      sidebarAccountScope: 'mine',
      rightPanelTabs: [],
      activeTabId: null,
      prevActiveTabId: null,
      panelVisible: false,
      rightPanelPinned: false,
    });
  },
  beginNavigationLoad: () => {
    let generation = 0;
    set((state) => {
      const next = beginRegionLoad(state.navigationLoadState);
      generation = next.generation;
      return { navigationLoadState: next };
    });
    return generation;
  },
  completeNavigationLoad: (generation) => set((state) => ({
    navigationLoadState: commitRegionReady(state.navigationLoadState, generation),
  })),
  failNavigationLoad: (generation, error) => set((state) => ({
    navigationLoadState: commitRegionError(state.navigationLoadState, generation, error),
  })),
  beginSessionSummaryLoad: (sessionId) => {
    let generation = 0;
    set((state) => {
      const next = beginRegionLoad(state.sessionSummaryLoadById[sessionId] ?? createRegionLoadState());
      generation = next.generation;
      return { sessionSummaryLoadById: { ...state.sessionSummaryLoadById, [sessionId]: next } };
    });
    return generation;
  },
  completeSessionSummaryLoad: (sessionId, generation) => set((state) => ({
    sessionSummaryLoadById: {
      ...state.sessionSummaryLoadById,
      [sessionId]: commitRegionReady(state.sessionSummaryLoadById[sessionId] ?? createRegionLoadState(), generation),
    },
  })),
  failSessionSummaryLoad: (sessionId, generation, error) => set((state) => ({
    sessionSummaryLoadById: {
      ...state.sessionSummaryLoadById,
      [sessionId]: commitRegionError(state.sessionSummaryLoadById[sessionId] ?? createRegionLoadState(), generation, error),
    },
  })),
  beginMessageLoad: (sessionId) => {
    let generation = 0;
    set((state) => {
      const next = beginRegionLoad(state.messageLoadBySession[sessionId] ?? createMessageRegionLoadState());
      generation = next.generation;
      return { messageLoadBySession: { ...state.messageLoadBySession, [sessionId]: next } };
    });
    return generation;
  },
  completeMessageLoad: (sessionId, generation) => set((state) => ({
    messageLoadBySession: {
      ...state.messageLoadBySession,
      [sessionId]: commitRegionReady(state.messageLoadBySession[sessionId] ?? createMessageRegionLoadState(), generation),
    },
  })),
  failMessageLoad: (sessionId, generation, error) => set((state) => ({
    messageLoadBySession: {
      ...state.messageLoadBySession,
      [sessionId]: commitRegionError(state.messageLoadBySession[sessionId] ?? createMessageRegionLoadState(), generation, error),
    },
  })),
  updateMessageRegion: (sessionId, generation, updates) => set((state) => {
    const current = state.messageLoadBySession[sessionId] ?? createMessageRegionLoadState();
    if (current.generation !== generation) return state;
    return {
      messageLoadBySession: {
        ...state.messageLoadBySession,
        [sessionId]: { ...current, ...updates, generation },
      },
    };
  }),
  applyMessageSync: (sessionId, incomingMessages, revision, hasMore, nextCursor) => set((state) => ({
    messages: {
      ...state.messages,
      [sessionId]: mergeMessagesById(state.messages[sessionId] || [], incomingMessages),
    },
    messageLoadBySession: {
      ...state.messageLoadBySession,
      [sessionId]: {
        ...(state.messageLoadBySession[sessionId] ?? createMessageRegionLoadState()),
        status: 'ready',
        revision,
        cacheSource: 'network',
        hasMore,
        nextCursor,
        dirty: false,
        error: null,
      },
    },
  })),
  applyMessageSaved: (sessionId, message, revision, settleStreaming = false) => set((state) => {
    const current = state.messageLoadBySession[sessionId] ?? createMessageRegionLoadState();
    const disposition = getMessageRevisionDisposition(current.revision, revision);
    const hasAuthoritativeSnapshot = current.cacheSource !== 'none' && current.revision !== null;
    const shouldApplyTerminalStatus = disposition !== 'stale'
      && isAssistantTerminalMessage(message);
    return {
      messages: {
        ...state.messages,
        [sessionId]: mergeMessagesById(state.messages[sessionId] || [], [message]),
      },
      messageLoadBySession: {
        ...state.messageLoadBySession,
        [sessionId]: {
          ...current,
          revision: disposition === 'stale' ? current.revision : revision,
          cacheSource: 'network',
          dirty: current.dirty || !hasAuthoritativeSnapshot || disposition === 'gap' || disposition === 'stale',
        },
      },
      sessions: state.sessions.map((session) => session.id === sessionId
        ? {
            ...session,
            ...(shouldApplyTerminalStatus ? { status: message.outcome } : {}),
          }
        : session),
      ...(settleStreaming && isAssistantTerminalMessage(message) && disposition !== 'stale' && state.streaming.streamingSessionId === sessionId ? {
        streaming: {
          isWaiting: false,
          waitingStage: 'submitted' as const,
          isStreaming: false,
          isStopping: false,
          currentContent: '',
          processContent: '',
          currentPhase: null,
          startTime: null,
          errorMessage: null,
          processSteps: [],
          processTimeline: [],
          streamingSessionId: null,
          blocks: [],
          tokenUsage: null,
        },
      } : {}),
    };
  }),
  setActiveSession: (id, options) => {
    if(id&&get().activeSessionId!==id)tracker.track('feature_view',{feature:'session',action:'open',surface:'unknown'});
    const state = get();
    for (const tab of state.rightPanelTabs) disposeFilePreviewTab(tab);
    if (id) storeSessionChatLocation(id);
    else storeEmptyChatLocation(
      state.currentProjectId,
      undefined,
      options?.autoOpenProjectPicker ?? true,
      options?.projectSelectionLocked ?? false,
    );
    // 切换会话时，如果当前不在流式状态则清空（防止串台）；流式中则保留（让消息完成时能正确保存到原会话）
    // 同时清空右侧面板选项卡
    if (id) {
      const session = state.sessions.find((s) => s.id === id);
      if (session?.project_id) {
        set({ activeSessionId: id, pendingRestoreSessionId: null, activeSessionOpenVersion: state.activeSessionOpenVersion + 1, currentProjectId: session.project_id, pendingProjectPath: null, projectSelectionLocked: false, rightPanelTabs: [], activeTabId: null, prevActiveTabId: null, panelVisible: false, rightPanelPinned: false });
      } else {
        set({ activeSessionId: id, pendingRestoreSessionId: null, activeSessionOpenVersion: state.activeSessionOpenVersion + 1, pendingProjectPath: null, projectSelectionLocked: false, rightPanelTabs: [], activeTabId: null, prevActiveTabId: null, panelVisible: false, rightPanelPinned: false });
      }
    } else {
      set({ activeSessionId: id, pendingRestoreSessionId: null, activeSessionOpenVersion: state.activeSessionOpenVersion + 1, autoOpenProjectPicker: options?.autoOpenProjectPicker ?? true, projectSelectionLocked: options?.projectSelectionLocked ?? false, rightPanelTabs: [], activeTabId: null, prevActiveTabId: null, panelVisible: false, rightPanelPinned: false });
    }
  },
  addSession: (session) => set((state) => ({
    sessions: state.sessions.some((item) => item.id === session.id)
      ? state.sessions.map((item) => item.id === session.id
        ? mergeSessionByPreferencesRevision(item, { ...item, ...session })
        : item)
      : [session, ...state.sessions],
  })),
  upsertSession: (session) => set((state) => ({
    sessions: state.sessions.some((item) => item.id === session.id)
      ? state.sessions.map((item) => item.id === session.id
        ? mergeSessionByPreferencesRevision(item, { ...item, ...session })
        : item)
      : [session, ...state.sessions],
  })),
  ensureSession: (session) => set((state) => (
    state.sessions.some((item) => item.id === session.id)
      ? state
      : { sessions: [session, ...state.sessions] }
  )),
  updateSessionPinned: (id, pinned) => set((state) => ({
    sessions: state.sessions.map((s) => s.id === id ? { ...s, pinned: pinned ? 1 : 0 } : s),
  })),
  updateSessionTitle: (id, title) => set((state) => ({
    sessions: state.sessions.map((s) => s.id === id ? { ...s, title } : s),
  })),
  updateSession: (session) => set((state) => ({
    sessions: state.sessions.map((item) => {
      if (item.id !== session.id) return item;
      if (session.engine_preferences
        && session.engine_preferences.revision < item.engine_preferences.revision) {
        const { engine_preferences: _stalePreferences, ...safeSession } = session;
        return { ...item, ...safeSession };
      }
      return { ...item, ...session };
    }),
  })),
  updateSessionStatus: (id, status) => set((state) => ({
    sessions: state.sessions.map((session) => session.id === id ? { ...session, status } : session),
  })),
  removeSession: (id) => {
    const state = get();
    const removedSession = state.sessions.find((session) => session.id === id);
    const removingActiveSession = state.activeSessionId === id;
    if (removingActiveSession) {
      for (const tab of state.rightPanelTabs) disposeFilePreviewTab(tab);
      storeEmptyChatLocation(
        removedSession?.project_id ?? state.currentProjectId,
        undefined,
        false,
      );
    }
    set((current) => ({
      sessions: current.sessions.filter((session) => session.id !== id),
      ...(removingActiveSession ? {
        activeSessionId: '',
        activeSessionOpenVersion: current.activeSessionOpenVersion + 1,
        autoOpenProjectPicker: false,
        projectSelectionLocked: false,
        currentProjectId: removedSession?.project_id ?? current.currentProjectId,
        pendingProjectPath: null,
        rightPanelTabs: [],
        activeTabId: null,
        prevActiveTabId: null,
        panelVisible: false,
        rightPanelPinned: false,
      } : {}),
    }));
  },

  messages: {},
  setMessages: (sessionId, messages) =>
    set((state) => ({
      messages: { ...state.messages, [sessionId]: messages },
    })),
  mergeMessages: (sessionId, messages) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: mergeMessagesById(state.messages[sessionId] || [], messages),
      },
    })),
  prependMessages: (sessionId, messages) =>
    set((state) => {
      const current = state.messages[sessionId] || [];
      const currentIds = new Set(current.map((message) => message.id));
      const older = messages.filter((message, index) =>
        !currentIds.has(message.id)
        && messages.findIndex((candidate) => candidate.id === message.id) === index
      );
      if (older.length === 0) return state;
      return {
        messages: {
          ...state.messages,
          // Current entries win over summary pages, while the shared merge
          // restores the store-wide oldest-to-newest ordering invariant.
          [sessionId]: mergeMessagesById(older, current),
        },
      };
    }),
  addMessage: (sessionId, message) =>
    set((state) => {
      const current = state.messages[sessionId] || [];
      if (current.some((item) => item.id === message.id)) return state;
      return {
        messages: {
          ...state.messages,
          [sessionId]: [...current, message],
        },
      };
    }),
  removeMessage: (sessionId, messageId) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: (state.messages[sessionId] || []).filter((message) => message.id !== messageId),
      },
    })),

  streaming: { isWaiting: false, waitingStage: 'submitted', isStreaming: false, isStopping: false, currentContent: '', processContent: '', currentPhase: null, startTime: null, errorMessage: null, processSteps: [], processTimeline: [], streamingSessionId: null, blocks: [], tokenUsage: null },
  applyRuntimeStreamingSnapshot: (snapshot) =>
    set(() => {
      const presentation = snapshot.processSteps.reduce(
        (current, item) => upsertProcessStep(current.processSteps, current.blocks, item),
        { processSteps: [] as ProcessStep[], blocks: [] as StreamingBlock[] },
      );
      const deferFinalAnswer = snapshot.isStreaming && Boolean(snapshot.currentContent);
      let processTimeline = [...snapshot.processTimeline];
      // Reconnected snapshots may only carry text; keep live output visible
      // as process narrative until the authoritative saved message replaces it.
      if (snapshot.isStreaming && processTimeline.every((entry) => entry.type !== 'narrative')) {
        if (snapshot.processContent) {
          processTimeline = appendNarrativeDelta(processTimeline, 'runtime-process', snapshot.processContent);
        }
        if (snapshot.currentContent) {
          processTimeline = appendNarrativeDelta(processTimeline, 'runtime-final', snapshot.currentContent);
        }
      }
      const blocks = !deferFinalAnswer && snapshot.currentContent
        ? [...presentation.blocks, { type: 'text' as const, content: snapshot.currentContent }]
        : presentation.blocks;
      return {
        streaming: {
          isWaiting: !snapshot.isStreaming && !snapshot.isStopping,
          waitingStage: snapshot.isStreaming ? 'started' : snapshot.waitingStage,
          isStreaming: snapshot.isStreaming,
          isStopping: snapshot.isStopping,
          currentContent: deferFinalAnswer ? '' : snapshot.currentContent,
          processContent: snapshot.processContent,
          currentPhase: snapshot.currentContent
            ? 'final_answer'
            : snapshot.processContent
              ? 'commentary'
              : null,
          startTime: snapshot.startTime ?? Date.now(),
          errorMessage: null,
          processSteps: presentation.processSteps,
          processTimeline,
          streamingSessionId: snapshot.sessionId,
          blocks,
          tokenUsage: null,
        },
      };
    }),
  startWaiting: (startTime, stage = 'submitted') =>
    set({ streaming: { isWaiting: true, waitingStage: stage, isStreaming: false, isStopping: false, currentContent: '', processContent: '', currentPhase: null, startTime: startTime ?? Date.now(), errorMessage: null, processSteps: [], processTimeline: [], streamingSessionId: null, blocks: [], tokenUsage: null } }),
  markRequestForwarded: () =>
    set((state) => ({ streaming: { ...state.streaming, waitingStage: 'forwarded' } })),
  startStreaming: () =>
    set((state) => ({
      streaming: { ...state.streaming, isWaiting: false, isStreaming: true, isStopping: false, waitingStage: 'started', currentPhase: null, errorMessage: null },
    })),
  startStopping: () =>
    set((state) => ({ streaming: { ...state.streaming, isWaiting: false, isStopping: true, errorMessage: null } })),
  appendDelta: (content, phase, itemId, observedAt) =>
    set((state) => {
      if (phase === 'commentary' || phase === 'final_answer') {
        return {
          streaming: {
            ...state.streaming,
            isWaiting: false,
            processContent: state.streaming.processContent + content,
            processTimeline: itemId
              ? appendNarrativeDelta(state.streaming.processTimeline, itemId, content, observedAt)
              : state.streaming.processTimeline,
            currentPhase: phase,
          },
        };
      }
      const blocks = [...state.streaming.blocks];
      // 追加到最后一个 text block（如果存在），否则创建新的
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock && lastBlock.type === 'text') {
        blocks[blocks.length - 1] = { type: 'text', content: (lastBlock.content || '') + content };
      } else {
        blocks.push({ type: 'text', content });
      }
      return {
        streaming: {
          ...state.streaming,
          isWaiting: false,
          currentContent: state.streaming.currentContent + content,
          currentPhase: phase || state.streaming.currentPhase,
          blocks,
        },
      };
    }),
  addProcessStep: (item) =>
    set((state) => {
      const next = upsertProcessStep(state.streaming.processSteps, state.streaming.blocks, item);
      return {
        streaming: {
          ...state.streaming,
          processSteps: next.processSteps,
          processTimeline: isProcessTimelineOperationType(item.type)
            ? insertOperationReference(state.streaming.processTimeline, item.id)
            : state.streaming.processTimeline,
          blocks: next.blocks,
        },
      };
    }),
  updateProcessStep: (item) =>
    set((state) => {
      const next = upsertProcessStep(state.streaming.processSteps, state.streaming.blocks, item);
      return {
        streaming: {
          ...state.streaming,
          processSteps: next.processSteps,
          processTimeline: isProcessTimelineOperationType(item.type)
            ? insertOperationReference(state.streaming.processTimeline, item.id)
            : state.streaming.processTimeline,
          blocks: next.blocks,
        },
      };
    }),
  setProcessTimeline: (timeline) =>
    set((state) => ({ streaming: { ...state.streaming, processTimeline: [...timeline] } })),
  setStreamingSessionId: (id) =>
    set((state) => ({ streaming: { ...state.streaming, streamingSessionId: id } })),
  setStreamingTokenUsage: (usage) =>
    set((state) => ({ streaming: { ...state.streaming, tokenUsage: usage } })),
  finishStreaming: () =>
    set({ streaming: { isWaiting: false, waitingStage: 'submitted', isStreaming: false, isStopping: false, currentContent: '', processContent: '', currentPhase: null, startTime: null, errorMessage: null, processSteps: [], processTimeline: [], streamingSessionId: null, blocks: [], tokenUsage: null } }),
  setNonTerminalError: (message, sessionId) => {
    const state = get();
    const target = sessionId || state.streaming.streamingSessionId || state.activeSessionId;
    if (target) useSessionOperationErrorStore.getState().set(target, message);
  },
  setError: (message, sessionId) =>
    set((state) => ({
      streaming: {
        ...state.streaming,
        isWaiting: false,
        waitingStage: 'submitted',
        isStreaming: false,
        isStopping: false,
        currentContent: '',
        processContent: '',
        currentPhase: null,
        startTime: null,
        errorMessage: message,
        processSteps: [],
        processTimeline: [],
        streamingSessionId: sessionId || state.streaming.streamingSessionId || state.activeSessionId,
        blocks: [],
        tokenUsage: null,
      },
    })),

  sidebarOpen: typeof window === 'undefined' ? true : isDesktopSidebarViewport(window.innerWidth),
  sidebarAccountScope: 'mine',
  connectionError: null,
  protocolMismatch: null,
  toggleSidebar: () => {tracker.action({feature:'layout',action:'toggle_sidebar',surface:'sidebar'});set((state) => ({ sidebarOpen: !state.sidebarOpen }));},
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarAccountScope: (scope) => set({ sidebarAccountScope: scope }),
  setConnectionError: (message) => set({ connectionError: message }),
  setProtocolMismatch: (protocolMismatch) => set({ protocolMismatch }),

  tokenUsageBySession: {},
  setTokenUsage: (sessionId, usage) => set((state) => ({
    tokenUsageBySession: { ...state.tokenUsageBySession, [sessionId]: usage },
  })),

  rightPanelTabs: [],
  activeTabId: null,
  prevActiveTabId: null,
  rightPanelWidth: readStoredRightPanelWidth(),
  panelVisible: false,
  rightPanelPinned: false,
  openRightPanel: (params) => {
    const state = get();
    const id = generateUUID();
    const { title, ...tabParams } = params;
    const newTab: RightPanelTab = { id, title, content: params.content ?? '', ...tabParams };
    // 如果同名 tab 已存在，更新它并切换过去
    const existing = state.rightPanelTabs.find((t) => t.title === params.title);
    if (existing) {
      if(!state.panelVisible)tracker.action({feature:'file_preview',action:'restore',surface:'message_file'});
      else if(state.activeTabId!==existing.id)tracker.action({feature:'file_preview',action:'activate',surface:'message_file'});
      disposeFilePreviewTab(existing);
      set({
        rightPanelTabs: state.rightPanelTabs.map((t) =>
          t.id === existing.id ? { ...t, ...params, content: params.content ?? t.content } : t
        ),
        activeTabId: existing.id,
        panelVisible: true,
      });
      return existing.id;
    } else {
      tracker.track('feature_view',{feature:'file_preview',action:'open',surface:'message_file'});
      set({
        rightPanelTabs: [...state.rightPanelTabs, newTab],
        activeTabId: id,
        panelVisible: true,
      });
      return id;
    }
  },
  closeRightPanel: () => {
    const state = get();
    if (state.activeTabId) {
      const closing = state.rightPanelTabs.find((tab) => tab.id === state.activeTabId);
      if(closing)tracker.action({feature:'file_preview',action:'close',surface:'keyboard'});
      if (closing) disposeFilePreviewTab(closing);
      const remaining = state.rightPanelTabs.filter((t) => t.id !== state.activeTabId);
      const newActive = remaining.length > 0 ? remaining[remaining.length - 1].id : null;
      set({ rightPanelTabs: remaining, activeTabId: newActive });
    }
  },
  closeRightPanelTab: (tabId) => {
    const state = get();
    const closing = state.rightPanelTabs.find((tab) => tab.id === tabId);
    if(closing)tracker.action({feature:'file_preview',action:'close',surface:'preview_tab'});
    if (closing) disposeFilePreviewTab(closing);
    const remaining = state.rightPanelTabs.filter((t) => t.id !== tabId);
    const newActive = state.activeTabId === tabId
      ? (remaining.length > 0 ? remaining[remaining.length - 1].id : null)
      : state.activeTabId;
    set({
      rightPanelTabs: remaining,
      activeTabId: newActive,
      ...(remaining.length === 0
        ? { prevActiveTabId: null, panelVisible: false, rightPanelPinned: false }
        : {}),
    });
  },
  closeAllRightPanelTabs: () => {
    if(get().rightPanelTabs.length)tracker.action({feature:'file_preview',action:'close_all',surface:'preview_toolbar'});
    for (const tab of get().rightPanelTabs) disposeFilePreviewTab(tab);
    set({ rightPanelTabs: [], activeTabId: null, prevActiveTabId: null, panelVisible: false, rightPanelPinned: false });
  },
  hideRightPanel: () => {if(get().panelVisible)tracker.action({feature:'file_preview',action:'minimize',surface:'preview_toolbar'});set({ panelVisible: false });},
  setActiveTabId: (id) => {if(id!==get().activeTabId)tracker.action({feature:'file_preview',action:'activate',surface:'preview_tab'});set({ activeTabId: id });},
  updateRightPanelTab: (tabId, params) => {
    if (!get().rightPanelTabs.some((tab) => tab.id === tabId)) return false;
    set((state) => ({
      rightPanelTabs: state.rightPanelTabs.map((tab) => {
      if (tab.id !== tabId) return tab;
      return { ...tab, ...params };
      }),
    }));
    return true;
  },
  setRightPanelWidth: (width) => set({ rightPanelWidth: width }),
  toggleRightPanelPinned: () => {tracker.action({feature:'file_preview',action:get().rightPanelPinned?'unpin':'pin',surface:'preview_toolbar'});set((state) => ({ rightPanelPinned: !state.rightPanelPinned }));},
  toggleRightPanel: () => {
    const state = get();
    if (state.panelVisible) {
      tracker.action({feature:'file_preview',action:'minimize',surface:'keyboard'});
      // 当前可见 → 隐藏
      set({ panelVisible: false });
    } else {
      // 当前隐藏 → 打开面板
      tracker.action({feature:'file_preview',action:'restore',surface:'keyboard'});
      // 如果有 tab，恢复之前的 tab；没有 tab 时打开空白页
      const restoreId = state.prevActiveTabId && state.rightPanelTabs.some((t) => t.id === state.prevActiveTabId)
        ? state.prevActiveTabId
        : (state.rightPanelTabs.length > 0 ? state.rightPanelTabs[state.rightPanelTabs.length - 1].id : null);
      set({ panelVisible: true, activeTabId: restoreId });
    }
  },
}));
