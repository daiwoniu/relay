import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { useFeatureView,featureAction } from '../../analytics/features';
import { useChatStore } from '../../stores/chat';
import IconActionButton from '../ui/IconActionButton';
import ExpandCornersIcon from '../ui/ExpandCornersIcon';
import { appendNoteToDraft } from '../../stores/local-notes';
import { useChatInputHistory } from './use-chat-input-history';
import { clearChatDraft, getChatDraftKey, readChatDraft, writeChatDraft } from './chat-drafts';
import type { EngineId, EnginePreferencesDto, EngineStatusDto, SendAttachmentDto } from '../../generated/relay-contracts';
import { useEngineModelsStore } from '../../stores/engine-models';
import { resolveComposerModelPreferences } from './composer-model-preferences';
import { updateSessionEnginePreferences } from '../../api/sessions';
import { authorizeHostFiles } from '../../api/filesystem';
import AttachmentDraftList from './AttachmentDraftList';
import { getHostFileDraftKey, readHostFileDrafts, type HostFileDraft } from './host-file-drafts';
import {
  getAttachmentDraftKey,
  hasUnreadyAttachments,
  MAX_ATTACHMENTS_PER_MESSAGE,
  mergeHostAttachmentDrafts,
  readAttachmentDrafts,
  selectUploadFiles,
  writeAttachmentDrafts,
  type AttachmentDraft,
  type PendingUploadedAttachmentDraft,
  type ReadyUploadedAttachmentDraft,
} from './attachment-drafts';
import { deleteUploadDraft, uploadProjectFile, type UploadProjectFileTask } from '../../api/project-uploads';
import { generateUUID } from '../../utils/uuid';
import { getVisualLineCount } from './chat-input-layout';
import {
  getHostFileDirectoryKey,
  readHostFileDirectory,
  rememberHostFileDirectory,
} from './host-file-directory-memory';
import {
  beginSubmissionState,
  clearSubmissionState,
  getSubmissionPhase,
  updateSubmissionState,
  type SubmissionState,
} from './submission-state';
import type { SuggestedReplyCandidate } from './suggested-reply';
import {
  getContextUsagePresentation,
  selectContextUsageSnapshot,
} from './context-usage-presentation';
import {
  CONTEXT_SESSION_HANDOFF_REQUEST,
  buildContextSessionContinuationDraft,
  findContextSessionHandoffSummary,
  hasContextSessionHandoffDraftConflict,
} from './context-session-handoff';
import {
  consumeSuggestedReplySelection,
  dismissSuggestedReplyDraftState,
  getSuggestedReplyDraftKey,
  readSuggestedReplyDraftState,
  resolveSuggestedReplyPrefill,
  writeSuggestedReplyDraftState,
  type SuggestedReplyDraftState,
} from './suggested-reply-draft';
import {
  shouldFocusComposerOnDevice,
  type ComposerFocusHandler,
  type ComposerFocusReason,
  type ComposerFocusRequest,
} from './composer-focus';
import ChatInputMetadataBar, { type ChatInputMobileDetails } from './ChatInputMetadataBar';
import ChatInputAddContentControl from './ChatInputAddContentControl';
import ChatInputSubmitControl from './ChatInputSubmitControl';
import ChatInputDialogs from './ChatInputDialogs';
import { restoreMinimizedPanel } from '../ui/minimizedPanelRegistry';
import ContextUsageDetails from './ContextUsageDetails';
import ComposerStatusNotice from './ComposerStatusNotice';
import { getComposerStatusNotices, isEngineStatusBlocking, prioritizeComposerStatusNotices, type ComposerNoticePayload } from './composer-status-notice';
import ModelSettingsControl from './ModelSettingsControl';
import { TRANSIENT_NOTICE_DELAY_MS, useDelayedComposerStatusNotices } from './delayed-composer-status-notice';
import { useAuth } from '../../auth/AuthContext';
import { filterSelectableProjects } from '../layout/session-project';
import { extractTransferredFiles, hasTransferredFiles } from './composer-file-transfer';
import { createAttachmentTransferQueue, createAttachmentUploadQueue } from './attachment-upload-queue';
import { readWorkspaceTaskLaunch } from '../workspace-console/workspace-task-launch';

interface Props {
  onSend: (content: string, attachments: SendAttachmentDto[], messageId: string, onConfirmationState?: (state: 'verifying') => void, enginePreferences?: EnginePreferencesDto) => Promise<boolean>;
  onEnsureProject: () => Promise<string>;
  onStop?: () => void;
  onCancelQueued?: () => void;
  isStreaming: boolean;
  isStopping?: boolean;
  isAwaitingAction?: boolean;
  canRespondToInteraction?: boolean;
  isQueued?: boolean;
  isQueueWaiting?: boolean;
  isCancellingQueued?: boolean;
  sessionId?: string | null;
  projectName?: string;
  selectedEngine: EngineId | null;
  engineStatuses: EngineStatusDto[];
  engineLocked: boolean;
  engineFallbackNotice?: string | null;
  onEngineChange: (engine: EngineId) => () => void;
  onEngineStatusesChange: (statuses: EngineStatusDto[]) => void;
  engineStatusNotice?: ComposerNoticePayload | null;
  tokenUsageAvailable: boolean;
  wideLayout?: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  suggestedReply?: SuggestedReplyCandidate | null;
  focusRequest?: ComposerFocusRequest | null;
  registerComposerFocusHandler: (handler: ComposerFocusHandler) => () => void;
}

export default function ChatInput({ onSend, onEnsureProject, onStop, onCancelQueued, isStreaming, isStopping = false, isAwaitingAction = false, canRespondToInteraction = true, isQueued = false, isQueueWaiting = false, isCancellingQueued = false, sessionId, projectName, selectedEngine, engineStatuses, engineLocked, engineFallbackNotice, onEngineChange, onEngineStatusesChange, engineStatusNotice = null, tokenUsageAvailable, wideLayout = false, expanded, onExpandedChange, suggestedReply = null, focusRequest = null, registerComposerFocusHandler }: Props) {
  useFeatureView('composer',true,'composer');
  const { user } = useAuth();
  const [projectMenuAnchor, setProjectMenuAnchor] = useState<DOMRect | null>(null);
  const [extensionMenuAnchor, setExtensionMenuAnchor] = useState<DOMRect | null>(null);
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [showHostFilePicker, setShowHostFilePicker] = useState(false);
  const [submissionState, setSubmissionState] = useState<SubmissionState | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<ComposerNoticePayload | null>(null);
  const [queuedPresentationSessionId, setQueuedPresentationSessionId] = useState<string | null>(null);
  const [mobileDetails, setMobileDetails] = useState<ChatInputMobileDetails | null>(null);
  const editingStarted=useRef(false);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const engineSelectionRequired = !selectedEngine;
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1024);
  const [visualLineCount, setVisualLineCount] = useState(1);
  const [isFileDragActive, setIsFileDragActive] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const projectMenuButtonRef = useRef<HTMLButtonElement>(null);
  const lastAutoOpenedEmptySessionVersionRef = useRef<number | null>(null);
  const inputFocusFrameRef = useRef<number | null>(null);
  const lastHandledFocusRequestIdRef = useRef(0);
  const pendingStopFocusSourceRef = useRef<HTMLElement | null>(null);
  const deviceFileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const uploadTasksRef = useRef(new Map<string, UploadProjectFileTask>());
  const uploadQueueRef = useRef(createAttachmentUploadQueue());
  const transferQueueRef = useRef(createAttachmentTransferQueue());
  const attachmentsRef = useRef<AttachmentDraft[]>([]);
  const attachmentDraftKeyRef = useRef('');
  const messageDraftIdRef = useRef<string | null>(null);
  const deletingAttachmentDraftKeysRef = useRef(new Set<string>());
  const [deletingAttachmentDraftKeys, setDeletingAttachmentDraftKeys] = useState<Set<string>>(new Set());
  const pendingCaretPositionRef = useRef<number | null>(null);
  const suggestedReplyStateRef = useRef<SuggestedReplyDraftState | null>(null);
  const suggestedReplySelectionPendingRef = useRef(false);
  const stopClickedRef = useRef(false);
  const {
    projects,
    sessions,
    currentProjectId,
    setCurrentProject,
    setPendingProject,
    setActiveSession,
    pendingProjectPath,
    activeSessionId,
    pendingRestoreSessionId,
    activeSessionOpenVersion,
    autoOpenProjectPicker,
    projectSelectionLocked,
    messages,
    streaming,
    tokenUsageBySession,
    updateSession,
  } = useChatStore();
  const sessionTokenUsage = activeSessionId ? tokenUsageBySession[activeSessionId] : undefined;
  const currentSession = sessions.find((session) => session.id === activeSessionId);
  const currentTurnTokenUsage = streaming.streamingSessionId === activeSessionId
    ? streaming.tokenUsage || undefined
    : undefined;

  const draftKey = getChatDraftKey({ sessionId: activeSessionId, pendingProjectPath, currentProjectId });
  useEffect(() => { setClearConfirmOpen(false); }, [draftKey]);
  useLayoutEffect(() => { onExpandedChange(false); }, [draftKey, onExpandedChange]);
  const suggestedReplyDraftKey = getSuggestedReplyDraftKey(draftKey);
  const attachmentDraftKey = getAttachmentDraftKey(draftKey);
  const hostFileDirectoryKey = getHostFileDirectoryKey(draftKey);
  attachmentDraftKeyRef.current = attachmentDraftKey;
  const deletingCurrentDraftAttachment = deletingAttachmentDraftKeys.has(attachmentDraftKey);
  const submissionPhase = getSubmissionPhase(submissionState, attachmentDraftKey);
  const isSubmitting = submissionPhase !== 'idle';
  const engineUnavailable = isEngineStatusBlocking(engineStatusNotice);
  const modelDraftKey = activeSessionId || draftKey;
  const modelCatalogEntry = useEngineModelsStore((state) => selectedEngine ? state.byEngine[selectedEngine] : undefined);
  const modelDraft = useEngineModelsStore((state) => state.draftBySession[modelDraftKey]);
  const loadModels = useEngineModelsStore((state) => state.load);
  const setModelDraft = useEngineModelsStore((state) => state.setDraft);
  const clearModelDraft = useEngineModelsStore((state) => state.clearDraft);
  const authorityPreferences = currentSession?.engine ? currentSession.engine_preferences : undefined;
  const applicableDraft = modelDraft?.engineId === selectedEngine ? modelDraft : undefined;
  const selectedPreferences = resolveComposerModelPreferences(selectedEngine,user,authorityPreferences,applicableDraft);
  const selectedModelId = selectedPreferences.modelId;
  const selectedReasoningEffort = selectedPreferences.reasoningEffort;
  useEffect(() => {
    if (!selectedEngine) return;
    void loadModels(selectedEngine).catch(() => undefined);
  }, [loadModels, selectedEngine]);

  const tryFocusInput = useCallback((reason: ComposerFocusReason, sourceElement?: HTMLElement | null) => {
    if (!shouldFocusComposerOnDevice(reason, isMobile)) return true;
    const textarea = textareaRef.current;
    const activeElement = document.activeElement;
    const expectedSource = sourceElement === undefined
      ? (activeElement instanceof HTMLElement ? activeElement : null)
      : sourceElement;
    const focusMovedOutsideExpectedFlow = activeElement
      && activeElement !== document.body
      && activeElement !== document.documentElement
      && activeElement !== expectedSource
      && activeElement !== textarea;
    if (!document.hasFocus() || !textarea || textarea.disabled || focusMovedOutsideExpectedFlow) return false;
    textarea.focus();
    return document.activeElement === textarea;
  }, [isMobile]);

  const requestInputFocus = useCallback((reason: ComposerFocusReason, sourceElement?: HTMLElement | null) => {
    if (!shouldFocusComposerOnDevice(reason, isMobile)) return;
    if (inputFocusFrameRef.current !== null) window.cancelAnimationFrame(inputFocusFrameRef.current);
    const expectedSource = sourceElement === undefined
      ? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      : sourceElement;
    inputFocusFrameRef.current = window.requestAnimationFrame(() => {
      inputFocusFrameRef.current = null;
      tryFocusInput(reason, expectedSource);
    });
  }, [isMobile, tryFocusInput]);

  const handleComposerFocusRequest = useCallback((request: ComposerFocusRequest) => tryFocusInput(
    request.reason,
    request.sourceElement,
  ), [tryFocusInput]);

  useEffect(() => registerComposerFocusHandler(handleComposerFocusRequest), [handleComposerFocusRequest, registerComposerFocusHandler]);

  useEffect(() => () => {
    if (inputFocusFrameRef.current !== null) window.cancelAnimationFrame(inputFocusFrameRef.current);
  }, []);

  useEffect(() => {
    if (!focusRequest || focusRequest.id <= lastHandledFocusRequestIdRef.current) return;
    lastHandledFocusRequestIdRef.current = focusRequest.id;
    requestInputFocus(focusRequest.reason, focusRequest.sourceElement);
  }, [focusRequest, requestInputFocus]);
  const legacyAttachmentDraftKey = getHostFileDraftKey(draftKey);
  const [input, setInputState] = useState('');
  const [attachments, setAttachmentsState] = useState<AttachmentDraft[]>([]);
  useEffect(() => {
    setQueuedPresentationSessionId(null);
    if (!isQueueWaiting || !sessionId) return undefined;
    const timer = window.setTimeout(() => {
      setQueuedPresentationSessionId(sessionId);
    }, TRANSIENT_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isQueueWaiting, sessionId]);
  const queuedPresentationVisible = Boolean(
    isQueueWaiting && sessionId && queuedPresentationSessionId === sessionId,
  );
  const composerStatusNotices = getComposerStatusNotices({
    canRespondToInteraction,
    attachmentNotice,
    isAwaitingAction,
    engineStatusNotice,
    isQueued: isQueueWaiting,
    submissionPhase,
  });
  const visibleComposerStatusNotices = prioritizeComposerStatusNotices(useDelayedComposerStatusNotices(composerStatusNotices, attachmentDraftKey));
  const composerStatusNotice = visibleComposerStatusNotices[0] ?? null;
  const [suggestedReplyActive, setSuggestedReplyActive] = useState(false);
  const dismissActiveSuggestedReply = useCallback(() => {
    const dismissed = dismissSuggestedReplyDraftState(suggestedReplyStateRef.current);
    if (!dismissed || dismissed.status !== 'dismissed') return;
    suggestedReplyStateRef.current = dismissed;
    suggestedReplySelectionPendingRef.current = false;
    setSuggestedReplyActive(false);
    if (typeof sessionStorage !== 'undefined') {
      writeSuggestedReplyDraftState(sessionStorage, suggestedReplyDraftKey, dismissed);
    }
  }, [suggestedReplyDraftKey]);
  const setInput = (value: string) => {
    dismissActiveSuggestedReply();
    resetInputHistory();
    setInputState(value);
    if (typeof sessionStorage !== 'undefined') writeChatDraft(sessionStorage, draftKey, value);
  };

  useEffect(() => {
    const draft = typeof sessionStorage !== 'undefined' ? readChatDraft(sessionStorage, draftKey) : '';
    const storedState = typeof sessionStorage !== 'undefined'
      ? readSuggestedReplyDraftState(sessionStorage, suggestedReplyDraftKey)
      : null;
    const resolved = resolveSuggestedReplyPrefill({ draft, candidate: suggestedReply, state: storedState });
    suggestedReplyStateRef.current = resolved.state;
    suggestedReplySelectionPendingRef.current = resolved.selectionPending;
    setSuggestedReplyActive(resolved.active);
    setInputState(resolved.value);
    if (typeof sessionStorage !== 'undefined') {
      if (resolved.shouldPersistDraft) writeChatDraft(sessionStorage, draftKey, resolved.value);
      writeSuggestedReplyDraftState(sessionStorage, suggestedReplyDraftKey, resolved.state);
    }
  }, [draftKey, suggestedReply?.sourceMessageId, suggestedReply?.text, suggestedReplyDraftKey]);

  useEffect(() => {
    if (typeof sessionStorage === 'undefined') return;
    const raw = sessionStorage.getItem('relay:workspace-prefill');
    if (!raw) return;
    try {
      const pending = JSON.parse(raw) as { sessionId?: string; text?: string };
      const appliesToCurrentDraft = pending.sessionId ? pending.sessionId === sessionId : !sessionId;
      if (appliesToCurrentDraft && typeof pending.text === 'string' && pending.text.trim()) {
        setInput(pending.text);
        sessionStorage.removeItem('relay:workspace-prefill');
      }
    } catch { sessionStorage.removeItem('relay:workspace-prefill'); }
  }, [sessionId]);

  useEffect(() => {
    if (typeof sessionStorage === 'undefined' || sessionId || !currentProjectId) return;
    const launch = readWorkspaceTaskLaunch(sessionStorage, currentProjectId, Date.now());
    if (launch && !readChatDraft(sessionStorage, draftKey).trim()
      && readAttachmentDrafts(sessionStorage, attachmentDraftKey).length === 0) setInput(launch.text);
  }, [sessionId, currentProjectId, draftKey, attachmentDraftKey]);

  useEffect(() => {
    for (const task of uploadTasksRef.current.values()) task.abort();
    uploadTasksRef.current.clear();
    for (const attachment of attachmentsRef.current) {
      if (attachment.kind === 'uploaded_file' && attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    const restored = typeof sessionStorage !== 'undefined' ? readAttachmentDrafts(sessionStorage, attachmentDraftKey) : [];
    const legacy = restored.length === 0 && typeof sessionStorage !== 'undefined'
      ? readHostFileDrafts(sessionStorage, legacyAttachmentDraftKey).map((attachment) => ({ ...attachment, status: 'ready' as const }))
      : [];
    messageDraftIdRef.current = restored.find((attachment) => attachment.kind === 'uploaded_file')?.messageId || null;
    const nextAttachments = restored.length > 0 ? restored : legacy;
    attachmentsRef.current = nextAttachments;
    setAttachmentsState(nextAttachments);
    setAttachmentNotice(null);
  }, [attachmentDraftKey, legacyAttachmentDraftKey]);

  const updateAttachments = (updater: (current: AttachmentDraft[]) => AttachmentDraft[]) => {
    const next = updater(attachmentsRef.current);
    attachmentsRef.current = next;
    setAttachmentsState(next);
    if (typeof sessionStorage !== 'undefined') writeAttachmentDrafts(sessionStorage, attachmentDraftKey, next);
  };

  const updateAttachmentsForKey = (targetKey: string, updater: (current: AttachmentDraft[]) => AttachmentDraft[]) => {
    if (attachmentDraftKeyRef.current !== targetKey) return;
    const next = updater(attachmentsRef.current);
    attachmentsRef.current = next;
    setAttachmentsState(next);
    if (typeof sessionStorage !== 'undefined') writeAttachmentDrafts(sessionStorage, targetKey, next);
  };

  const removeReadyAttachmentForKey = (targetKey: string, attachment: ReadyUploadedAttachmentDraft) => {
    if (attachmentDraftKeyRef.current === targetKey) {
      const next = attachmentsRef.current.filter((entry) => entry.id !== attachment.id);
      attachmentsRef.current = next;
      setAttachmentsState(next);
      if (typeof sessionStorage !== 'undefined') writeAttachmentDrafts(sessionStorage, targetKey, next);
      messageDraftIdRef.current = next.find((entry) => entry.kind === 'uploaded_file')?.messageId || null;
      return;
    }
    if (typeof sessionStorage === 'undefined') return;
    const persisted = readAttachmentDrafts(sessionStorage, targetKey).filter((entry) => entry.id !== attachment.id);
    writeAttachmentDrafts(sessionStorage, targetKey, persisted);
  };

  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => () => {
    for (const task of uploadTasksRef.current.values()) task.abort();
    for (const attachment of attachmentsRef.current) {
      if (attachment.kind === 'uploaded_file' && attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
  }, []);

  useEffect(() => {
    stopClickedRef.current = false;
    setStopConfirmOpen(false);
  }, [isStreaming, isStopping, sessionId]);

  useEffect(() => {
    const sourceElement = pendingStopFocusSourceRef.current;
    if (!sourceElement || isStopping || isAwaitingAction) return;
    pendingStopFocusSourceRef.current = null;
    requestInputFocus('stop-finished', sourceElement);
  }, [isAwaitingAction, isStopping, requestInputFocus]);

  useEffect(() => {
    pendingStopFocusSourceRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 1024);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useLayoutEffect(() => {
    const caretPosition = pendingCaretPositionRef.current;
    const textarea = textareaRef.current;
    if (caretPosition === null || !textarea) return;

    textarea.focus();
    textarea.setSelectionRange(caretPosition, caretPosition);
    pendingCaretPositionRef.current = null;
  }, [input]);

  const updateTextareaLayout = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (expanded) {
      el.style.height = '';
      return;
    }

    el.style.height = 'auto';
    const styles = window.getComputedStyle(el);
    const { scrollHeight } = el;
    const lineHeight = Number.parseFloat(styles.lineHeight);
    const paddingTop = Number.parseFloat(styles.paddingTop);
    const paddingBottom = Number.parseFloat(styles.paddingBottom);
    setVisualLineCount(getVisualLineCount(scrollHeight, lineHeight, paddingTop, paddingBottom));
    el.style.height = `${Math.min(scrollHeight, 200)}px`;
  }, [expanded]);

  // Auto-resize textarea and track visual line wrapping.
  useLayoutEffect(() => {
    updateTextareaLayout();
  }, [input, updateTextareaLayout]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el || expanded || typeof ResizeObserver === 'undefined') return;
    let width = el.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = el.getBoundingClientRect().width;
      if (nextWidth === width || nextWidth === 0) return;
      width = nextWidth;
      updateTextareaLayout();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, updateTextareaLayout]);

  const handleClearInput = () => { if(input)featureAction('composer','clear','composer');setInput(''); setClearConfirmOpen(false); textareaRef.current?.focus(); };

  const selectSuggestedReplyOnce = useCallback((target: HTMLTextAreaElement, defer = false) => {
    if (!suggestedReplySelectionPendingRef.current) return false;
    suggestedReplySelectionPendingRef.current = false;
    const selected = consumeSuggestedReplySelection(suggestedReplyStateRef.current);
    suggestedReplyStateRef.current = selected;
    if (typeof sessionStorage !== 'undefined') {
      writeSuggestedReplyDraftState(sessionStorage, suggestedReplyDraftKey, selected);
    }
    const select = () => {
      if (!target.isConnected) return;
      target.select();
    };
    if (defer) {
      target.focus();
      window.requestAnimationFrame(select);
    } else {
      select();
    }
    return true;
  }, [suggestedReplyDraftKey]);

  const handleSuggestedReplyPointerDown = (event: React.PointerEvent<HTMLTextAreaElement>) => {
    if (!suggestedReplySelectionPendingRef.current) return;
    event.preventDefault();
    selectSuggestedReplyOnce(event.currentTarget, true);
  };

  const handleSuggestedReplyFocus = (event: React.FocusEvent<HTMLTextAreaElement>) => {
    selectSuggestedReplyOnce(event.currentTarget);
  };

  const handleSuggestedReplySelectionChange = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    if (!suggestedReplyActive) return;
    const target = event.currentTarget;
    const fullySelected = target.selectionStart === 0 && target.selectionEnd === target.value.length;
    if (!fullySelected) dismissActiveSuggestedReply();
  };

  const closeProjectMenu = useCallback(() => setProjectMenuAnchor(null), []);

  const doSend = async () => {
    const content = input.trim();
    if (engineUnavailable || engineSelectionRequired || (!content && attachments.length === 0) || isSubmitting
      || deletingAttachmentDraftKeysRef.current.has(attachmentDraftKey) || hasUnreadyAttachments(attachments)) return;
    setAttachmentNotice(null);
    const hostAttachments = attachments.filter((attachment) => attachment.kind === 'host_file');
    const submissionDraftKey = attachmentDraftKey;
    setSubmissionState(beginSubmissionState(
      submissionDraftKey,
      hostAttachments.length > 0 ? 'preparing-attachments' : 'sending',
    ));
    let shouldRestoreInputFocus = false;
    try {
      const authorizedHosts = hostAttachments.length > 0
        ? (await authorizeHostFiles(hostAttachments.map((attachment) => attachment.path))).attachments
        : [];
      let hostIndex = 0;
      const sendAttachments: SendAttachmentDto[] = attachments.map((attachment) => {
        if (attachment.kind === 'host_file') return authorizedHosts[hostIndex++];
        if (attachment.status !== 'ready') throw new Error('请等待附件上传完成或移除失败附件');
        const { status: _status, previewUrl: _previewUrl, ...draft } = attachment;
        return draft;
      });
      const messageId = messageDraftIdRef.current || generateUUID();
      setSubmissionState((current) => updateSubmissionState(current, submissionDraftKey, 'sending'));
      const enginePreferences: EnginePreferencesDto = authorityPreferences ?? {
        modelId: selectedModelId,
        reasoningEffort: selectedReasoningEffort,
        serviceTier: selectedPreferences?.serviceTier ?? null,
        revision: 0,
      };
      const accepted = await onSend(content, sendAttachments, messageId, (state) => {
        if (state === 'verifying') {
          setSubmissionState((current) => updateSubmissionState(current, submissionDraftKey, 'verifying'));
        }
      }, enginePreferences);
      if (attachmentDraftKeyRef.current === submissionDraftKey) shouldRestoreInputFocus = true;
      if (!accepted) return;
      if (!currentSession?.engine) clearModelDraft(modelDraftKey);
      if (typeof sessionStorage !== 'undefined') {
        clearChatDraft(sessionStorage, draftKey);
        writeAttachmentDrafts(sessionStorage, attachmentDraftKey, []);
        writeSuggestedReplyDraftState(sessionStorage, suggestedReplyDraftKey, null);
      }
      for (const attachment of attachments) {
        if (attachment.kind === 'uploaded_file' && attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      if (attachmentDraftKeyRef.current === submissionDraftKey) {
        resetInputHistory();
        setInputState('');
        suggestedReplyStateRef.current = null;
        suggestedReplySelectionPendingRef.current = false;
        setSuggestedReplyActive(false);
        setAttachmentsState([]);
        messageDraftIdRef.current = null;
        onExpandedChange(false);
      }
    } catch (error: unknown) {
      if (attachmentDraftKeyRef.current === submissionDraftKey) {
        shouldRestoreInputFocus = true;
        setAttachmentNotice({ message: error instanceof Error ? error.message : '发送失败，请重试', tone: 'danger',
          reason: '本次发送流程未正常完成，消息是否送达需要以消息列表为准。', nextStep: '先核对消息列表；若消息未送达，再检查错误并重新发送。' });
      }
    } finally {
      setSubmissionState((current) => clearSubmissionState(current, submissionDraftKey));
      if (shouldRestoreInputFocus) requestInputFocus('send-finished', null);
    }
  };

  const { handleKeyDown, resetInputHistory } = useChatInputHistory({
    isMobile, messages: activeSessionId ? messages[activeSessionId] || [] : [],
    draftKey, setInputState, pendingCaretPositionRef, onSend: () => void doSend(),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    console.log('[ChatInput] handleSubmit (form)');
    void doSend();
  };

  const handleStop = () => {
    if (stopClickedRef.current) return;
    featureAction('composer','stop','composer');
    stopClickedRef.current = true;
    const sourceElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pendingStopFocusSourceRef.current = sourceElement;
    onStop?.();
    if (!tryFocusInput('stop-finished', sourceElement)) requestInputFocus('stop-finished', sourceElement);
  };

  const handleStopRequest = () => {
    if (isMobile) {
      setStopConfirmOpen(true);
      return;
    }
    handleStop();
  };

  const confirmStop = () => {
    setStopConfirmOpen(false);
    handleStop();
  };

  const handleSelectDirectory = (dirPath: string) => {
    featureAction('composer','select_directory','composer');
    const sourceElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusedSynchronously = tryFocusInput('project-selected', sourceElement);
    setPendingProject(dirPath);
    setShowDirPicker(false);
    setProjectMenuAnchor(null);
    if (!focusedSynchronously) requestInputFocus('project-selected', sourceElement);
  };

  const handleInsertLocalNote = (content: string) => {
    const nextInput = appendNoteToDraft(input, content);
    pendingCaretPositionRef.current = nextInput.length;
    setInput(nextInput);
  };

  const handleAddHostFiles = (incoming: HostFileDraft[]) => {
    if(incoming.length)featureAction('attachments','select','host_picker');
    const sourceElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusedSynchronously = tryFocusInput('attachment-selected', sourceElement);
    const merged = mergeHostAttachmentDrafts(attachments, incoming);
    updateAttachments(() => merged.attachments);
    setShowHostFilePicker(false);
    if (merged.overflowCount > 0) setAttachmentNotice({ message: '每条消息最多添加 10 个附件', tone: 'warning', reason: '本次选择会让当前消息的附件数超过上限，超出的附件没有加入草稿。', nextStep: '移除部分附件后再添加需要的文件。' });
    else if (merged.duplicateCount > 0) setAttachmentNotice({ message: '已忽略重复选择的文件', tone: 'warning', reason: '当前消息中已包含相同文件，本次没有再次添加。', nextStep: '如需替换，请先移除已有附件。' });
    else setAttachmentNotice(null);
    if (!focusedSynchronously) requestInputFocus('attachment-selected', sourceElement);
  };

  const handleCancelDirectoryPicker = () => {
    const sourceElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusedSynchronously = tryFocusInput('attachment-cancelled', sourceElement);
    setShowDirPicker(false);
    if (!focusedSynchronously) requestInputFocus('attachment-cancelled', sourceElement);
  };

  const handleCancelHostFilePicker = () => {
    featureAction('attachments','cancel','host_picker');
    const sourceElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusedSynchronously = tryFocusInput('attachment-cancelled', sourceElement);
    setShowHostFilePicker(false);
    if (!focusedSynchronously) requestInputFocus('attachment-cancelled', sourceElement);
  };

  const handleSelectedUploadFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length > 0) {
      featureAction('attachments','select','device_picker');
      const focusedSynchronously = tryFocusInput('attachment-selected', event.currentTarget);
      if (!focusedSynchronously) requestInputFocus('attachment-selected', event.currentTarget);
    }
    queueUploadFiles(files);
    event.currentTarget.value = '';
  };

  const handleHostFileDirectoryChange = useCallback((directoryPath: string) => {
    if (typeof sessionStorage !== 'undefined') {
      rememberHostFileDirectory(sessionStorage, hostFileDirectoryKey, directoryPath);
    }
  }, [hostFileDirectoryKey]);

  const startUpload = (draft: PendingUploadedAttachmentDraft, projectId: string, targetDraftKey: string) => {
    const task = transferQueueRef.current.enqueue(() => uploadProjectFile(projectId, draft.file, {
      uploadId: draft.uploadId,
      messageId: draft.messageId,
      onProgress: (progress) => updateAttachmentsForKey(targetDraftKey, (current) => current.map((attachment) => (
        attachment.id === draft.id && attachment.status === 'uploading' ? { ...attachment, progress } : attachment
      ))),
    }));
    uploadTasksRef.current.set(draft.id, task);
    void task.promise.then(({ attachment }) => {
      updateAttachmentsForKey(targetDraftKey, (current) => current.map((entry) => entry.id === draft.id ? {
        ...attachment,
        status: 'ready' as const,
        ...(draft.previewUrl ? { previewUrl: draft.previewUrl } : {}),
      } : entry));
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      updateAttachmentsForKey(targetDraftKey, (current) => current.map((entry) => entry.id === draft.id && entry.kind === 'uploaded_file' ? {
        ...draft,
        status: 'failed' as const,
        progress: 0,
        error: error instanceof Error ? error.message : '上传失败，请重试',
      } : entry));
    }).finally(() => {
      if (uploadTasksRef.current.get(draft.id) === task) uploadTasksRef.current.delete(draft.id);
    });
  };

  const handleUploadFiles = async (files: File[], targetDraftKey: string) => {
    if (files.length === 0) return;
    if (attachmentDraftKeyRef.current !== targetDraftKey) return;
    let projectId: string;
    try { projectId = await onEnsureProject(); }
    catch (error) {
      setAttachmentNotice({ message: error instanceof Error ? error.message : '创建项目失败，无法上传附件', tone: 'danger',
        reason: '上传前需要确定附件所属项目，但当前未能完成该步骤。', nextStep: '检查项目状态后重新选择附件。' });
      return;
    }
    if (attachmentDraftKeyRef.current !== targetDraftKey) return;
    const currentAttachments = attachmentsRef.current;
    const selected = selectUploadFiles(currentAttachments, files);
    const notices = [
      selected.rejectedLarge ? `${selected.rejectedLarge} 个文件超过 50MB` : '',
      selected.rejectedTotal ? `${selected.rejectedTotal} 个文件使本条消息超过 200MB` : '',
      selected.rejectedDuplicate ? `${selected.rejectedDuplicate} 个重复文件` : '',
      selected.rejectedOverflow ? `${selected.rejectedOverflow} 个文件超过 10 个附件上限` : '',
    ].filter(Boolean);
    setAttachmentNotice(notices.length ? { message: `已忽略：${notices.join('、')}`, tone: 'warning', reason: '本次选择中有文件超出大小、总量或数量限制，或与当前附件重复；这些文件未加入草稿。', nextStep: '按提示调整文件或移除已有附件后重新选择。' } : null);
    if (selected.accepted.length === 0) return;
    const messageId = messageDraftIdRef.current || generateUUID();
    const drafts = selected.accepted.map((file): PendingUploadedAttachmentDraft => ({
      id: generateUUID(),
      kind: 'uploaded_file',
      status: 'uploading',
      messageId,
      uploadId: generateUUID(),
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      progress: 0,
      file,
      ...(file.type.startsWith('image/') ? { previewUrl: URL.createObjectURL(file) } : {}),
    }));
    messageDraftIdRef.current = messageId;
    updateAttachmentsForKey(targetDraftKey, (current) => [...current, ...drafts]);
    for (const draft of drafts) startUpload(draft, projectId, targetDraftKey);
  };

  const queueUploadFiles = (files: File[]) => {
    if (files.length === 0) return;
    const targetDraftKey = attachmentDraftKey;
    void uploadQueueRef.current.enqueue(() => handleUploadFiles(files, targetDraftKey)).catch((error: unknown) => {
      if (attachmentDraftKeyRef.current !== targetDraftKey) return;
      setAttachmentNotice({
        message: error instanceof Error ? error.message : '处理附件失败，请重试',
        tone: 'danger',
      });
    });
  };

  const handlePasteFiles = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (isMobile || isSubmitting) return;
    const files = extractTransferredFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    queueUploadFiles(files);
    featureAction('attachments','select','paste');
  };

  const handleFileDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (isMobile || !hasTransferredFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (isSubmitting) return;
    event.dataTransfer.dropEffect = 'copy';
    setIsFileDragActive(true);
  };

  const handleFileDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (isMobile || !hasTransferredFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (isSubmitting) return;
    event.dataTransfer.dropEffect = 'copy';
    if (!isFileDragActive) setIsFileDragActive(true);
  };

  const handleFileDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsFileDragActive(false);
  };

  const handleFileDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (isMobile || !hasTransferredFiles(event.dataTransfer)) return;
    event.preventDefault();
    setIsFileDragActive(false);
    if (isSubmitting) return;
    const files = extractTransferredFiles(event.dataTransfer);
    if (files.length > 0){featureAction('attachments','select','drop');queueUploadFiles(files);}
  };

  const removeAttachment = async (id: string, reason: 'remove' | 'cancel' = 'remove') => {
    const attachment = attachments.find((entry) => entry.id === id);
    if (!attachment) return;
    const targetDraftKey = attachmentDraftKey;
    uploadTasksRef.current.get(id)?.abort();
    uploadTasksRef.current.delete(id);
    if (attachment.kind === 'uploaded_file') {
      if (attachment.status === 'ready') {
        if (deletingAttachmentDraftKeysRef.current.has(targetDraftKey)) return;
        deletingAttachmentDraftKeysRef.current.add(targetDraftKey);
        setDeletingAttachmentDraftKeys(new Set(deletingAttachmentDraftKeysRef.current));
        try {
          await deleteUploadDraft(attachment.projectId, attachment.uploadId);
          removeReadyAttachmentForKey(targetDraftKey, attachment);
          if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
          if (attachmentDraftKeyRef.current === targetDraftKey) setAttachmentNotice(null);
        }
        catch (error) {
          if (attachmentDraftKeyRef.current === targetDraftKey) {
            setAttachmentNotice({ message: error instanceof Error ? error.message : '删除上传草稿失败，请重试', tone: 'danger' });
          }
        } finally {
          deletingAttachmentDraftKeysRef.current.delete(targetDraftKey);
          setDeletingAttachmentDraftKeys(new Set(deletingAttachmentDraftKeysRef.current));
        }
        return;
      }
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    updateAttachments((current) => current.filter((entry) => entry.id !== id));
    if(reason==='remove')featureAction('attachments','remove_local','composer');
    if (attachments.filter((entry) => entry.id !== id && entry.kind === 'uploaded_file').length === 0) messageDraftIdRef.current = null;
    setAttachmentNotice(null);
  };

  const cancelUpload = (id: string) => {featureAction('attachments','cancel','composer'); void removeAttachment(id,'cancel'); };

  const retryUpload = async (id: string) => {
    const failed = attachments.find((entry): entry is PendingUploadedAttachmentDraft => entry.id === id && entry.kind === 'uploaded_file' && entry.status === 'failed');
    if (!failed) return;
    const targetDraftKey = attachmentDraftKey;
    try {
      const projectId = await onEnsureProject();
      if (attachmentDraftKeyRef.current !== targetDraftKey) return;
      const current = attachmentsRef.current.find((entry) => entry.id === id);
      if (current?.status !== 'failed' || uploadTasksRef.current.has(id)) return;
      const retryDraft: PendingUploadedAttachmentDraft = { ...failed, status: 'uploading', progress: 0, error: undefined };
      updateAttachmentsForKey(targetDraftKey, (current) => current.map((entry) => entry.id === id ? retryDraft : entry));
      startUpload(retryDraft, projectId, targetDraftKey);
    } catch (error) {
      if (attachmentDraftKeyRef.current === targetDraftKey) {
        setAttachmentNotice({ message: error instanceof Error ? error.message : '重试上传失败', tone: 'danger' });
      }
    }
  };

  const currentProject = projects.find((p) => p.id === currentProjectId);
  const selectableProjects = filterSelectableProjects(projects, user?.id);
  const rememberedHostFilePath = typeof sessionStorage !== 'undefined'
    ? readHostFileDirectory(sessionStorage, hostFileDirectoryKey)
    : '';

  // 显示名：优先 pendingProjectPath，其次当前项目名
  const pendingName = pendingProjectPath
    ? pendingProjectPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || pendingProjectPath
    : null;
  const displayName = projectName || pendingName || currentProject?.name || '选择项目';

  // 待恢复位置尚未校验时，也不能把它当作可选项目的新会话。
  const canSelectProject = !activeSessionId && !pendingRestoreSessionId && !projectSelectionLocked;

  useLayoutEffect(() => {
    if (!canSelectProject || !autoOpenProjectPicker) {
      setProjectMenuAnchor(null);
      return;
    }
    if (lastAutoOpenedEmptySessionVersionRef.current === activeSessionOpenVersion) return;
    const anchorRect = projectMenuButtonRef.current?.getBoundingClientRect();
    if (!anchorRect) return;
    lastAutoOpenedEmptySessionVersionRef.current = activeSessionOpenVersion;
    setProjectMenuAnchor(anchorRect);
  }, [activeSessionOpenVersion, autoOpenProjectPicker, canSelectProject]);

  const contextUsageSnapshot = useMemo(
    () => selectContextUsageSnapshot(sessionTokenUsage, currentTurnTokenUsage, isStreaming),
    [currentTurnTokenUsage, isStreaming, sessionTokenUsage],
  );
  const displayedTokenUsage = contextUsageSnapshot.tokenUsage;
  const contextUsage = useMemo(
    () => getContextUsagePresentation(displayedTokenUsage, contextUsageSnapshot.scope),
    [contextUsageSnapshot.scope, displayedTokenUsage],
  );
  const currentSessionMessages = activeSessionId ? messages[activeSessionId] || [] : [];
  const contextSessionHandoffSummary = useMemo(
    () => findContextSessionHandoffSummary(currentSessionMessages),
    [currentSessionMessages],
  );
  const newSessionDraftKey = getChatDraftKey({ sessionId: null, pendingProjectPath, currentProjectId });
  const newSessionAttachmentDraftKey = getAttachmentDraftKey(newSessionDraftKey);
  const newSessionDraft = typeof sessionStorage !== 'undefined'
    ? readChatDraft(sessionStorage, newSessionDraftKey)
    : '';
  const newSessionAttachmentCount = typeof sessionStorage !== 'undefined'
    ? readAttachmentDrafts(sessionStorage, newSessionAttachmentDraftKey).length
    : 0;
  const contextSessionHandoffDraftConflict = hasContextSessionHandoffDraftConflict(
    newSessionDraft,
    newSessionAttachmentCount,
  );
  const contextGovernanceBusy = isStreaming || isQueued || isAwaitingAction || isSubmitting;
  const contextGovernanceDraftBlocked = !contextSessionHandoffSummary
    && (input.trim().length > 0 || attachments.length > 0);
  const contextGovernanceActionDisabled = contextGovernanceBusy || contextGovernanceDraftBlocked;
  const handlePrepareContextHandoff = (sourceElement: HTMLElement) => {
    if (contextGovernanceActionDisabled || contextSessionHandoffSummary) return;
    setInput(CONTEXT_SESSION_HANDOFF_REQUEST);
    setMobileDetails(null);
    requestInputFocus('new-chat', sourceElement);
  };
  const handleContinueContextInNewSession = (sourceElement: HTMLElement) => {
    if (contextGovernanceBusy || !contextSessionHandoffSummary || typeof sessionStorage === 'undefined') return;
    const continuationDraft = buildContextSessionContinuationDraft(contextSessionHandoffSummary);
    if (!continuationDraft) return;
    const latestNewSessionDraft = readChatDraft(sessionStorage, newSessionDraftKey);
    const latestNewSessionAttachments = readAttachmentDrafts(sessionStorage, newSessionAttachmentDraftKey);
    if (hasContextSessionHandoffDraftConflict(latestNewSessionDraft, latestNewSessionAttachments.length)) return;
    writeChatDraft(sessionStorage, newSessionDraftKey, continuationDraft);
    setMobileDetails(null);
    setActiveSession('', { autoOpenProjectPicker: false });
    requestInputFocus('new-chat', sourceElement);
  };
  const contextUsageDetails = (
    <ContextUsageDetails
      contextUsage={contextUsage}
      tokenUsage={displayedTokenUsage}
      count={currentSession?.context_compaction_count ?? 0}
      mobile={isMobile}
      actionDisabled={contextSessionHandoffSummary
        ? contextGovernanceBusy || contextSessionHandoffDraftConflict
        : contextGovernanceActionDisabled}
      actionLabel={contextGovernanceBusy
        ? '当前任务进行中'
        : contextSessionHandoffSummary
          ? contextSessionHandoffDraftConflict
            ? '请先处理新会话草稿'
            : '携带交接新建会话'
          : contextGovernanceDraftBlocked
            ? '请先处理当前草稿'
            : contextUsage.handoffAction.actionLabel}
      onAction={(sourceElement) => contextSessionHandoffSummary
        ? handleContinueContextInNewSession(sourceElement)
        : handlePrepareContextHandoff(sourceElement)}
    />
  );
  const modelSettingsControl = selectedEngine ? (
    <ModelSettingsControl
      models={modelCatalogEntry?.catalog?.models ?? []}
      modelId={selectedModelId}
      reasoningEffort={selectedReasoningEffort}
      serviceTier={selectedPreferences?.serviceTier ?? null}
      loading={modelCatalogEntry?.status === 'loading'}
      catalogError={modelCatalogEntry?.error}
      engineId={selectedEngine}
      applyDisabled={isStreaming || isQueued || isAwaitingAction || isSubmitting}
      isMobile={isMobile}
      onOpen={() => { void loadModels(selectedEngine, { refresh: true }).catch(() => undefined); }}
      onApply={async (preferences) => {
        if (currentSession?.engine) {
          const result = await updateSessionEnginePreferences(currentSession.id, {
            ...preferences,
            expectedRevision: currentSession.engine_preferences.revision,
          });
          updateSession(result.session);
          return;
        }
        setModelDraft(modelDraftKey, selectedEngine, preferences);
        featureAction('composer','apply_model_draft','composer');
      }}
    />
  ) : <span className="truncate whitespace-nowrap text-xs text-[var(--color-text-tertiary)]">请先选择引擎</span>;

  const isInputMultiline = visualLineCount > 1;
  const showClearInput = (isInputMultiline || expanded) && input.length > 0 && !isAwaitingAction && !isSubmitting;
  const showExpandInput = expanded || (visualLineCount > 3 && input.length > 0);

  return (
    <>
      <div className={`composer-shell theme-region-section shrink-0 border-t border-[var(--color-border)] ${expanded ? 'h-full' : ''}`}>
        <form onSubmit={handleSubmit} className={`${wideLayout ? 'w-full max-w-none' : 'max-w-3xl'} mx-auto px-4 pt-1 pb-0 ${expanded ? 'flex h-full flex-col overflow-y-auto' : ''}`}>
          <ChatInputMetadataBar
            projects={selectableProjects}
            currentProjectId={currentProjectId}
            currentProject={currentProject}
            displayName={displayName}
            canSelectProject={canSelectProject}
            canCreateProject={user?.canCreateProject !== false}
            projectMenuButtonRef={projectMenuButtonRef}
            projectMenuAnchor={projectMenuAnchor}
            onToggleProjectMenu={(button) => {
              const anchorRect = button.getBoundingClientRect();
              setProjectMenuAnchor((current) => current ? null : anchorRect);
            }}
            onCloseProjectMenu={closeProjectMenu}
            onSelectProject={(projectId) => {
              featureAction('composer','select_project','composer');
              setCurrentProject(projectId);
              closeProjectMenu();
            }}
            onOpenDirectoryPicker={() => {
              if (user?.canCreateProject === false) return;
              closeProjectMenu();
              restoreMinimizedPanel('directory-picker-title');
              setShowDirPicker(true);
            }}
            selectedEngine={selectedEngine}
            engineStatuses={engineStatuses}
            engineLocked={engineLocked}
            engineFallbackNotice={engineFallbackNotice}
            isMobile={isMobile}
            onEngineChange={(engine) => () => { if(engine!==selectedEngine)featureAction('composer','select_engine','composer');onEngineChange(engine)(); }}
            onEngineStatusesChange={onEngineStatusesChange}
            modelSettingsControl={modelSettingsControl}
            onOpenMobileDetails={setMobileDetails}
            activeSessionId={activeSessionId}
            tokenUsageAvailable={tokenUsageAvailable}
            contextUsage={contextUsage}
            contextCompactionCount={currentSession?.context_compaction_count ?? 0}
            contextUsageDetails={contextUsageDetails}
          />
          <AttachmentDraftList
            attachments={attachments}
            disabled={isSubmitting || deletingCurrentDraftAttachment}
            onRemove={removeAttachment}
            onCancel={cancelUpload}
            onRetry={retryUpload}
          />
          <ComposerStatusNotice scopeKey={attachmentDraftKey} notice={composerStatusNotice} notices={visibleComposerStatusNotices} />

          {/* 输入区域 */}
          <div
            className={`composer-surface theme-input-surface relative flex items-end gap-2 rounded-2xl border px-1.5 py-2 transition-[min-height,border-color,box-shadow,background-color] focus-within:border-[var(--color-primary)]/50 ${isFileDragActive ? 'border-[var(--color-primary)] ring-2 ring-[var(--color-primary)]/20' : 'border-[var(--color-border)]'} ${expanded ? 'min-h-28 flex-1' : isInputMultiline ? 'min-h-[84px]' : ''}`}
            onDragEnter={handleFileDragEnter}
            onDragOver={handleFileDragOver}
            onDragLeave={handleFileDragLeave}
            onDrop={handleFileDrop}
          >
            {isFileDragActive && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-[var(--color-bg)]/90 text-sm font-medium text-[var(--color-primary)]">
                松开即可添加文件
              </div>
            )}
            <ChatInputAddContentControl
              anchorRect={extensionMenuAnchor}
              disabled={isSubmitting}
              isMobile={isMobile}
              deviceFileInputRef={deviceFileInputRef}
              imageInputRef={imageInputRef}
              cameraInputRef={cameraInputRef}
              onToggle={(button) => {
                const rect = button.getBoundingClientRect();
                setExtensionMenuAnchor((current) => current ? null : rect);
              }}
              onClose={() => setExtensionMenuAnchor(null)}
              onOpenHostFilePicker={() => {
                setExtensionMenuAnchor(null);
                restoreMinimizedPanel('host-file-picker-title');
                setShowHostFilePicker(true);
              }}
              onFilesSelected={handleSelectedUploadFiles}
              onInsertLocalNote={handleInsertLocalNote}
            />

            {(showClearInput || showExpandInput) && (
              <div className="absolute right-1.5 top-2 z-[2] flex w-8 flex-col">
                {showClearInput && <IconActionButton
                  label="清空文字"
                  variant="neutral"
                  className="h-8 w-8 rounded-xl"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => setClearConfirmOpen(true)}
                >
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </IconActionButton>}
                {showExpandInput && <IconActionButton
                  label={expanded ? '还原输入框' : '放大输入框'}
                  variant="neutral"
                  className="h-8 w-8 rounded-xl"
                  aria-expanded={expanded}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onExpandedChange(!expanded);
                    textareaRef.current?.focus();
                  }}
                >
                  <ExpandCornersIcon expanded={expanded} variant="diagonal" />
                </IconActionButton>}
              </div>
            )}

            <div className={`min-w-0 flex-1 ${expanded ? 'self-stretch' : ''}`}>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {if(e.target.value&&!editingStarted.current){editingStarted.current=true;featureAction('composer','edit_start','composer');}setInput(e.target.value);}}
                onBlur={()=>{editingStarted.current=false;}}
                onBeforeInput={(event) => selectSuggestedReplyOnce(event.currentTarget)}
                onPaste={handlePasteFiles}
                onKeyDown={handleKeyDown}
                onPointerDown={handleSuggestedReplyPointerDown}
                onFocus={handleSuggestedReplyFocus}
                onSelect={handleSuggestedReplySelectionChange}
                enterKeyHint="enter"
                placeholder="随心输入"
                readOnly={isSubmitting}
                rows={1}
                className={`relative z-[1] -ml-3.5 block w-[calc(100%+0.875rem)] resize-none bg-transparent py-2 pl-[18px] pr-1 text-sm outline-none placeholder:text-[var(--color-text-tertiary)] ${expanded ? 'h-full' : 'min-h-[24px] max-h-[200px]'}`}
              />
            </div>

            <ChatInputSubmitControl
              isStreaming={isStreaming}
              isStopping={isStopping}
              isAwaitingAction={isAwaitingAction}
              isQueued={queuedPresentationVisible}
              isCancellingQueued={isCancellingQueued}
              engineSelectionRequired={engineSelectionRequired}
              engineUnavailable={engineUnavailable}
              submissionPhase={submissionPhase}
              deletingAttachment={deletingCurrentDraftAttachment}
              hasUnreadyAttachments={hasUnreadyAttachments(attachments)}
              hasContent={Boolean(input.trim() || attachments.length > 0)}
              isMobile={isMobile}
              onStop={handleStopRequest}
              onCancelQueued={onCancelQueued}
            />
          </div>

          {/* AI 生成声明 */}
          <div className="text-center mt-0.5 mb-0.5">
            <span className="text-[11px] text-[var(--color-text-tertiary)]">
              {suggestedReplyActive ? '已填入建议回复，点击输入框可全选替换' : '内容由 AI 生成，请核实重要信息'}
            </span>
          </div>
        </form>
      </div>

      <ChatInputDialogs
        mobileDetails={mobileDetails}
        onCloseMobileDetails={() => setMobileDetails(null)}
        currentProject={currentProject}
        contextUsageDetails={contextUsageDetails}
        stopConfirmOpen={stopConfirmOpen}
        isAwaitingAction={isAwaitingAction}
        onCancelStop={() => {featureAction('composer','cancel_stop','composer');setStopConfirmOpen(false);}}
        onConfirmStop={confirmStop}
        clearConfirmOpen={clearConfirmOpen}
        onCancelClear={() => {featureAction('composer','cancel_clear','composer');setClearConfirmOpen(false);}}
        onConfirmClear={handleClearInput}
        showDirPicker={showDirPicker}
        initialDirectoryPath={pendingProjectPath || undefined}
        onSelectDirectory={handleSelectDirectory}
        onCancelDirectoryPicker={handleCancelDirectoryPicker}
        showHostFilePicker={showHostFilePicker}
        initialHostFilePath={rememberedHostFilePath || currentProject?.path}
        remainingHostFileSlots={Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - attachments.length)}
        existingHostFilePaths={attachments.filter((attachment) => attachment.kind === 'host_file').map((attachment) => attachment.path)}
        onHostFileDirectoryChange={handleHostFileDirectoryChange}
        onAddHostFiles={handleAddHostFiles}
        onCancelHostFilePicker={handleCancelHostFilePicker}
      />
    </>
  );
}
