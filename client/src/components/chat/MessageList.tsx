import { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import type { Message, ProcessStep, ProcessTimelineEntry, StreamingBlock } from '../../stores/chat';
import AssistantMessage from '../messages/AssistantMessage';
import UserMessage from '../messages/UserMessage';
import type { WaitingStage } from '../../utils/waiting-status';
import ErrorBoundary from '../ErrorBoundary';
import { getRunningMessageState } from './message-running-state';
import Tooltip from '../ui/Tooltip';
import type { InteractionResponseHandler } from '../messages/InteractionPanel';
import type { AsyncQuestionAnswerHandler } from '../messages/AsyncQuestionPanel';
import {
  getInitialVisibleMessageStart,
  getPrependedScrollTop,
  getPreviousVisibleMessageStart,
  MESSAGE_AUTO_SCROLL_THRESHOLD_PX,
  MESSAGE_HISTORY_LOAD_THRESHOLD_PX,
  shouldKeepLatestMessageVisibleAfterResize,
  shouldPreserveLocatedMessageWindow,
  shouldResetOlderMessageAvailability,
} from './message-history-window';
import { getSearchMessageWindowRange } from './session-search-navigation';
import {
  createTextMatchRanges,
  ensureSessionSearchHighlightStyle,
  getCenteredScrollTop,
} from './message-search-highlight';
import { getNextFollowLatestState } from './message-auto-scroll.ts';
import LatestMessageRefreshBubble from '../messages/LatestMessageRefreshBubble';
import type { LatestMessageRefreshStatus } from './latest-message-refresh';
import { hasVisibleProcessPresentation } from '../../stores/process-step-visibility';
import { groupHistoricalOperationRecords, isHistoricalOperationRecord } from './historical-operation-records';
import HistoricalOperationRecord from '../messages/HistoricalOperationRecord';
import { buildCompletedFlows, captureProcessFlow, getFlowCompletionMessage } from '../messages/process-flow-session';
import type { ProcessFlowContext } from '../messages/process-flow-model';
import type { EngineId, SessionFollowupDto } from '../../generated/relay-contracts';

const EMPTY_FOLLOWUPS: SessionFollowupDto[] = [];

const SESSION_SEARCH_HIGHLIGHT_NAME = 'relay-session-search-match';

export interface LoadOlderMessagesResult {
  loadedCount: number;
  hasMore: boolean;
}

interface Props {
  knownProjects?: ProcessFlowContext['knownProjects'];
  engine?: EngineId | null;
  projectName?: string;
  followups?: SessionFollowupDto[];
  sessionId?: string;
  messages: Message[];
  streamingContent: string;
  hasOlderMessages: boolean;
  onLoadOlder: () => Promise<LoadOlderMessagesResult>;
  streamingProcessContent: string;
  isWaiting: boolean;
  waitingStage: WaitingStage;
  isStreaming: boolean;
  isStopping: boolean;
  isAwaitingAction?: boolean;
  pendingActionKind?: 'approval' | 'input' | 'mixed' | null;
  isRecovering?: boolean;
  errorMessage: string | null;
  operationErrorMessage?: string;
  streamingStartTime?: number | null;
  streamingSteps?: ProcessStep[];
  streamingBlocks?: StreamingBlock[];
  streamingProcessTimeline?: ProcessTimelineEntry[];
  streamingTokenUsage?: Message['tokenUsage'];
  onInteractionRespond?: InteractionResponseHandler;
  onAsyncQuestionAnswer?: AsyncQuestionAnswerHandler;
  canAnswerAsyncQuestion?: boolean;
  shareSelectionMode?: boolean;
  selectableMessageIds?: Set<string>;
  selectedMessageIds?: Set<string>;
  onToggleShareSelection?: (messageId: string) => void;
  onShareMessage?: (messageId: string) => void;
  onForkMessage?: (messageId: string) => void;
  forkingMessageId?: string | null;
  searchTargetMessageId?: string | null;
  searchQuery?: string;
  searchTargetScope?: 'message' | 'process' | 'operation';
  searchTargetItemId?: string;
  projectPath?: string;
  mobile?: boolean;
  wideLayout?: boolean;
  onResync?: () => void;
  latestMessagesRefreshStatus?: LatestMessageRefreshStatus;
  onRetryLatestMessages?: () => void;
  onLoadMessageDetails?: (messageId: string) => Promise<void>;
}

export default function MessageList({ sessionId, messages, hasOlderMessages, onLoadOlder, streamingContent, streamingProcessContent, isWaiting, waitingStage, isStreaming, isStopping, isAwaitingAction, pendingActionKind, isRecovering, errorMessage, operationErrorMessage, streamingStartTime, streamingSteps, streamingBlocks, streamingProcessTimeline, streamingTokenUsage, onInteractionRespond, onAsyncQuestionAnswer, canAnswerAsyncQuestion, shareSelectionMode = false, selectableMessageIds = new Set(), selectedMessageIds = new Set(), onToggleShareSelection, onShareMessage, onForkMessage, forkingMessageId = null, searchTargetMessageId = null, searchQuery = '', searchTargetScope = 'message', searchTargetItemId, projectPath, mobile = false, wideLayout = false, onResync, latestMessagesRefreshStatus = 'idle', onRetryLatestMessages, onLoadMessageDetails, engine, projectName, followups = EMPTY_FOLLOWUPS, knownProjects }: Props) {
  const answeredAsyncQuestionIds = useMemo(() => new Set(messages.flatMap((message) => message.replyToAsyncQuestionId ? [message.replyToAsyncQuestionId] : [])), [messages]);
  const asyncQuestionAnswers = useMemo(() => new Map(messages.flatMap((message) => message.replyToAsyncQuestionId
    ? [[message.replyToAsyncQuestionId, message.content] as const]
    : [])), [messages]);
  const hasStreamingPresentation = Boolean(streamingContent)
    || hasVisibleProcessPresentation(streamingProcessContent, streamingSteps);
  const runningMessage = getRunningMessageState({
    isWaiting,
    isStreaming,
    isStopping,
    hasPresentation: hasStreamingPresentation,
    errorMessage,
    waitingStage,
  });
  const [flowContext, setFlowContext] = useState<ProcessFlowContext | null>(null);
  useEffect(() => {
    if (engine !== 'codex' || !sessionId) { setFlowContext(null); return; }
    if (!runningMessage.show) { setFlowContext(previous => previous?.sessionId === sessionId ? previous : null); return; }
    setFlowContext(previous => captureProcessFlow(previous, {
      sessionId, messages, followups, steps: streamingSteps || [], timeline: streamingProcessTimeline || [], projectName, projectPath, knownProjects,
    }) || (getFlowCompletionMessage(previous, messages) ? previous : null));
  }, [engine, sessionId, runningMessage.show, messages, followups, streamingSteps, streamingProcessTimeline, projectName, projectPath, knownProjects]);
  const currentFlowContext = engine === 'codex' && flowContext && flowContext.sessionId === sessionId ? flowContext : undefined;
  const flowCompletion = !runningMessage.show ? getFlowCompletionMessage(currentFlowContext || null, messages) : undefined;
  const completedFlows = useRef(new Map<string, ProcessFlowContext>());
  const historicalFlows = useMemo(() => {
    const flows = engine === 'codex' && !shareSelectionMode ? buildCompletedFlows(messages, completedFlows.current, { projectName, projectPath, knownProjects }) : new Map<string, ProcessFlowContext>();
    completedFlows.current = flows;
    return flows;
  }, [engine, shareSelectionMode, messages, projectName, projectPath, knownProjects]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const previousScrollTopRef = useRef(0);
  const [visibleStart, setVisibleStart] = useState(() => getInitialVisibleMessageStart(messages.length));
  const prependAnchorRef = useRef<{
    scrollTop: number;
    scrollHeight: number;
  } | null>(null);
  const previousSearchTargetRef = useRef(searchTargetMessageId);
  const preservedSearchTargetIndex = !searchTargetMessageId && previousSearchTargetRef.current
    ? messages.findIndex((message) => message.id === previousSearchTargetRef.current)
    : -1;
  const preservedSearchWindow = preservedSearchTargetIndex >= 0
    ? getSearchMessageWindowRange(preservedSearchTargetIndex, messages.length)
    : null;
  const effectiveVisibleStart = preservedSearchWindow?.start ?? (visibleStart > messages.length
    ? getInitialVisibleMessageStart(messages.length)
    : visibleStart);
  const searchTargetIndex = searchTargetMessageId
    ? messages.findIndex((message) => message.id === searchTargetMessageId)
    : -1;
  const searchTargetLoaded = searchTargetIndex >= 0;
  const searchTargetDetailsLoaded = searchTargetIndex >= 0
    ? Boolean(messages[searchTargetIndex]?.detailsLoaded || messages[searchTargetIndex]?.items || messages[searchTargetIndex]?.processContent)
    : false;
  const searchWindow = searchTargetMessageId
    ? getSearchMessageWindowRange(searchTargetIndex, messages.length)
    : null;
  const visibleMessages = searchWindow
    ? messages.slice(searchWindow.start, searchWindow.end)
    : messages.slice(effectiveVisibleStart);
  const historical = groupHistoricalOperationRecords(visibleMessages, shareSelectionMode || Boolean(searchTargetMessageId));
  const [canLoadOlder, setCanLoadOlder] = useState(hasOlderMessages);
  const followLatestRef = useRef(true);
  const processLayoutPausedRef = useRef(false);
  const [processLayoutPaused, setProcessLayoutPaused] = useState(false);
  const searchTargetMessageIdRef = useRef(searchTargetMessageId);
  searchTargetMessageIdRef.current = searchTargetMessageId;
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const loadingOlderRef = useRef(false);
  const previousMessageCountRef = useRef(messages.length);
  const scheduleScrollToBottom = useCallback(() => {
    if (
      searchTargetMessageIdRef.current
      || !followLatestRef.current
      || autoScrollFrameRef.current !== null
    ) return;

    autoScrollFrameRef.current = requestAnimationFrame(() => {
      autoScrollFrameRef.current = null;
      const container = scrollContainerRef.current;
      if (!container || searchTargetMessageIdRef.current || !followLatestRef.current) return;
      container.scrollTop = container.scrollHeight;
      previousScrollTopRef.current = container.scrollTop;
      setShowScrollToBottom(false);
    });
  }, []);

  useEffect(() => () => {
    if (autoScrollFrameRef.current !== null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    processLayoutPausedRef.current = false;
    setProcessLayoutPaused(false);
    followLatestRef.current = true;
  }, [sessionId]);

  useLayoutEffect(() => {
    scheduleScrollToBottom();
  }, [messages, searchTargetMessageId, streamingContent, streamingProcessContent, isWaiting, isStreaming, isStopping, errorMessage, streamingSteps, streamingBlocks, streamingProcessTimeline, visibleStart, scheduleScrollToBottom]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => scheduleScrollToBottom());
    observer.observe(content);
    return () => observer.disconnect();
  }, [scheduleScrollToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    let previousClientHeight = container.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextClientHeight = container.clientHeight;
      const shouldKeepLatestVisible = !searchTargetMessageId && !processLayoutPausedRef.current && (
        followLatestRef.current || shouldKeepLatestMessageVisibleAfterResize(
          container.scrollTop,
          container.scrollHeight,
          previousClientHeight,
          nextClientHeight,
        )
      );
      previousClientHeight = nextClientHeight;
      if (!shouldKeepLatestVisible) return;

      followLatestRef.current = true;
      setShowScrollToBottom(false);
      scheduleScrollToBottom();
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [searchTargetMessageId, scheduleScrollToBottom]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !searchTargetMessageId) return;
    followLatestRef.current = false;
    setShowScrollToBottom(false);
    const messageTarget = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'))
      .find((element) => element.dataset.messageId === searchTargetMessageId);
    if (!messageTarget) return;
    const highlightRegistry = (CSS as typeof CSS & {
      highlights?: { set: (name: string, highlight: unknown) => void; delete: (name: string) => void };
    }).highlights;
    const HighlightConstructor = (globalThis as typeof globalThis & {
      Highlight?: new (...ranges: Range[]) => unknown;
    }).Highlight;
    let frame = 0;
    let attempts = 0;
    const locateTarget = () => {
      const scopedTarget = searchTargetScope === 'message'
        ? messageTarget.querySelector<HTMLElement>('[data-search-content]')
        : messageTarget.querySelector<HTMLElement>(`[data-search-target="${searchTargetScope}:${searchTargetItemId || ''}"]`);
      if (!scopedTarget && attempts < 8) {
        attempts += 1;
        frame = requestAnimationFrame(locateTarget);
        return;
      }
      const target = scopedTarget || messageTarget;
      const searchContent = scopedTarget
        ? (scopedTarget.matches('[data-search-content]') ? scopedTarget : scopedTarget.querySelector<HTMLElement>('[data-search-content]'))
        : searchTargetScope === 'message'
          ? messageTarget.querySelector<HTMLElement>('[data-search-content]')
          : null;
      const ranges = searchContent ? createTextMatchRanges(searchContent, searchQuery) : [];
      if (ranges.length === 0 && attempts < 12) {
        attempts += 1;
        frame = requestAnimationFrame(locateTarget);
        return;
      }
      if (ranges.length > 0) {
        if (highlightRegistry && HighlightConstructor) {
          ensureSessionSearchHighlightStyle();
          highlightRegistry.set(SESSION_SEARCH_HIGHLIGHT_NAME, new HighlightConstructor(...ranges));
        }
        const matchRect = ranges[0].getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        container.scrollTo({
          top: getCenteredScrollTop(container.scrollTop, containerRect.top, container.clientHeight, matchRect.top, matchRect.height),
          behavior: 'smooth',
        });
      } else {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    };
    frame = requestAnimationFrame(locateTarget);

    return () => {
      cancelAnimationFrame(frame);
      highlightRegistry?.delete(SESSION_SEARCH_HIGHLIGHT_NAME);
    };
  }, [searchQuery, searchTargetDetailsLoaded, searchTargetItemId, searchTargetLoaded, searchTargetMessageId, searchTargetScope]);

  useLayoutEffect(() => {
    const previousTarget = previousSearchTargetRef.current;
    previousSearchTargetRef.current = searchTargetMessageId;
    if (!shouldPreserveLocatedMessageWindow(previousTarget, searchTargetMessageId)) return;

    const previousTargetIndex = messages.findIndex((message) => message.id === previousTarget);
    if (previousTargetIndex < 0) return;

    const container = scrollContainerRef.current;
    const preservedWindow = getSearchMessageWindowRange(previousTargetIndex, messages.length);
    setVisibleStart(preservedWindow.start);
    const distanceToBottom = container
      ? container.scrollHeight - container.scrollTop - container.clientHeight
      : Number.POSITIVE_INFINITY;
    const followingLatest = distanceToBottom <= MESSAGE_AUTO_SCROLL_THRESHOLD_PX;
    followLatestRef.current = followingLatest;
    setShowScrollToBottom(!followingLatest);
  }, [messages, searchTargetMessageId]);
  useEffect(() => {
    if (visibleStart <= messages.length) return;
    setVisibleStart(getInitialVisibleMessageStart(messages.length));
  }, [messages.length, visibleStart]);

  useEffect(() => {
    if (hasOlderMessages) setCanLoadOlder(true);
  }, [hasOlderMessages]);

  useEffect(() => {
    if (shouldResetOlderMessageAvailability(previousMessageCountRef.current, messages.length, hasOlderMessages)) {
      setCanLoadOlder(true);
    }
    previousMessageCountRef.current = messages.length;
  }, [hasOlderMessages, messages.length]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const anchor = prependAnchorRef.current;
    if (!container || !anchor) return;

    container.scrollTop = getPrependedScrollTop(
      anchor.scrollTop,
      anchor.scrollHeight,
      container.scrollHeight,
    );
    prependAnchorRef.current = null;
  }, [messages.length, visibleStart]);

  const loadOlderMessages = (container: HTMLDivElement) => {
    if (prependAnchorRef.current || loadingOlderRef.current) return;

    if (visibleStart > 0) {
      const nextVisibleStart = getPreviousVisibleMessageStart(visibleStart);
      if (nextVisibleStart === visibleStart) return;

      prependAnchorRef.current = {
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
      };
      setVisibleStart(nextVisibleStart);
      return;
    }

    if (!canLoadOlder) return;

    prependAnchorRef.current = {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
    };
    loadingOlderRef.current = true;
    void onLoadOlder()
      .then(({ loadedCount, hasMore }) => {
        setCanLoadOlder(hasMore);
        if (loadedCount === 0) prependAnchorRef.current = null;
      })
      .catch((error) => {
        prependAnchorRef.current = null;
        console.error('自动加载更早消息失败', error);
      })
      .finally(() => {
        loadingOlderRef.current = false;
      });
  };

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (!searchTargetMessageId && container.scrollTop <= MESSAGE_HISTORY_LOAD_THRESHOLD_PX) {
      loadOlderMessages(container);
    }
    const followingLatest = getNextFollowLatestState({
      manuallyPaused: processLayoutPausedRef.current,
      followingLatest: followLatestRef.current,
      previousScrollTop: previousScrollTopRef.current,
      scrollTop: container.scrollTop,
      distanceToBottom,
    });
    previousScrollTopRef.current = container.scrollTop;
    followLatestRef.current = followingLatest;
    setShowScrollToBottom(!followingLatest);
  };

  const scrollToBottom = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    processLayoutPausedRef.current = false;
    setProcessLayoutPaused(false);
    followLatestRef.current = true;
    container.scrollTop = container.scrollHeight;
    previousScrollTopRef.current = container.scrollTop;
    setShowScrollToBottom(false);
    scheduleScrollToBottom();
  };

  const pauseForProcessLayout = (event: { target: EventTarget | null }) => {
    const target = event.target instanceof Element ? event.target : null;
    const control = target?.closest('button[aria-expanded], button[aria-pressed], summary, .process-flow__group-select, .flow-more, .process-timeline__collapse, .process-flow__activity button');
    if (!control?.closest('.process-timeline')) return;
    processLayoutPausedRef.current = true;
    setProcessLayoutPaused(true);
    followLatestRef.current = false;
    if (autoScrollFrameRef.current !== null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
    setShowScrollToBottom(true);
  };

  return (
    <div className="relative flex-1 min-h-0 min-w-0">
      <div
        ref={scrollContainerRef}
        data-overlay-scroll-preserve
        onScroll={handleScroll}
        onClickCapture={pauseForProcessLayout}
        onChangeCapture={pauseForProcessLayout}
        className="h-full overflow-y-auto min-h-0 min-w-0"
      >
        <div ref={contentRef} className={`${wideLayout ? 'w-full max-w-none' : 'max-w-3xl'} mx-auto px-4 py-6 space-y-6`}>
          {visibleMessages.filter((msg) => !historical.nestedIds.has(msg.id)).map((msg) =>
            msg.role === 'user' ? (
              <UserMessage
                key={msg.id}
                content={msg.content}
                attachments={msg.attachments}
                createdAt={msg.created_at}
                messageId={msg.id}
                searchTarget={msg.id === searchTargetMessageId}
                origin={msg.origin}
                mobile={mobile}
                selectionMode={shareSelectionMode}
                selectable={selectableMessageIds.has(msg.id)}
                selected={selectedMessageIds.has(msg.id)}
                onToggleSelection={() => onToggleShareSelection?.(msg.id)}
              />
            ) : !shareSelectionMode && isHistoricalOperationRecord(msg) ? (
              <HistoricalOperationRecord key={msg.id} message={msg} onLoadDetails={onLoadMessageDetails}
                searchTarget={msg.id === searchTargetMessageId} searchTargetScope={searchTargetScope} searchTargetItemId={searchTargetItemId} />
            ) : (
            <ErrorBoundary key={msg.id} fallback={
              <div className="flex justify-start">
                <div className="max-w-[90%] rounded-lg border border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)] px-4 py-3 text-sm text-[var(--color-status-warning)]">
                  <div className="flex items-start gap-2">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 mt-0.5">
                      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M8 4v5M8 11v0.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                    <span>此消息渲染失败（ID: {msg.id.slice(-8)}）</span>
                  </div>
                </div>
              </div>
            }>
              <AssistantMessage
                flowContext={!shareSelectionMode ? msg.id === flowCompletion?.id ? currentFlowContext : historicalFlows.get(msg.id) : undefined}
                historicalRecords={historical.byReply.has(msg.id) ? historical.byReply.get(msg.id)!.map((record) => (
                  <HistoricalOperationRecord key={record.id} message={record} onLoadDetails={onLoadMessageDetails} />
                )) : undefined}
                historicalRecordCount={historical.byReply.get(msg.id)?.length}
                sessionId={sessionId || msg.session_id}
                content={msg.content}
                duration={msg.duration}
                createdAt={msg.created_at}
                items={msg.items}
                processContent={msg.processContent}
                processTimeline={msg.processTimeline}
                changedFiles={msg.changedFiles}
                changedFilesIncomplete={msg.changedFilesIncomplete}
                hasDetails={msg.hasDetails}
                detailsLoaded={msg.detailsLoaded}
                processItemCount={msg.processItemCount}
                asyncQuestionIds={msg.asyncQuestionIds}
                processNarrativeCount={msg.processNarrativeCount}
                changedFileCount={msg.changedFileCount}
                onLoadDetails={onLoadMessageDetails && msg.hasDetails ? () => onLoadMessageDetails(msg.id) : undefined}
                deferMarkdown={Boolean(msg.deferredMarkdown && msg.id !== messages[messages.length - 1]?.id && msg.id !== searchTargetMessageId && !msg.detailsLoaded)}
                optimizeContentVisibility={Boolean(msg.id !== messages[messages.length - 1]?.id && msg.id !== searchTargetMessageId && !msg.detailsLoaded)}
                projectPath={projectPath}
                mobile={mobile}
                stopped={msg.stopped}
                outcome={msg.outcome}
                executionStage={msg.executionStage}
                errorCode={msg.errorCode}
                errorMessage={msg.errorMessage}
                tokenUsage={msg.tokenUsage}
                modelInfo={msg.modelInfo}
                onAsyncQuestionAnswer={onAsyncQuestionAnswer}
                answeredAsyncQuestionIds={answeredAsyncQuestionIds}
                asyncQuestionAnswers={asyncQuestionAnswers}
                canAnswerAsyncQuestion={canAnswerAsyncQuestion}
                messageId={msg.id}
                searchTarget={msg.id === searchTargetMessageId}
                searchTargetScope={msg.id === searchTargetMessageId ? searchTargetScope : undefined}
                searchTargetItemId={msg.id === searchTargetMessageId ? searchTargetItemId : undefined}
                selectionMode={shareSelectionMode}
                selectable={selectableMessageIds.has(msg.id)}
                selected={selectedMessageIds.has(msg.id)}
                onToggleSelection={() => onToggleShareSelection?.(msg.id)}
                onShare={!shareSelectionMode && selectableMessageIds.has(msg.id) ? () => onShareMessage?.(msg.id) : undefined}
                onFork={!shareSelectionMode && onForkMessage && msg.turn_id && !msg.stopped && msg.outcome === 'completed'
                  ? () => onForkMessage(msg.id)
                  : undefined}
                forkPending={forkingMessageId === msg.id}
              />
            </ErrorBoundary>
            )
          )}

          {/* 错误提示 */}
          {operationErrorMessage && <div role="status" className="rounded-lg border border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)] px-3 py-2 text-sm text-[var(--color-text-secondary)]">
            <span>{operationErrorMessage}</span>
            {onResync && <button type="button" onClick={onResync} className="ml-2 text-[var(--color-primary)]">同步状态</button>}
          </div>}
          {errorMessage && (
          <AssistantMessage
            flowContext={!shareSelectionMode && !flowCompletion ? currentFlowContext : undefined}
            projectPath={projectPath}
            content=""
            outcome="failed"
            executionStage="accepted"
            errorMessage={errorMessage}
          />
          )}

          {/* 等待、处理、停止统一使用 AssistantMessage 气泡 */}
          {runningMessage.show && (
          <AssistantMessage
            sessionId={sessionId}
            flowContext={!shareSelectionMode ? currentFlowContext : undefined}
            projectPath={projectPath}
            content={streamingContent}
            processContent={streamingProcessContent}
            processTimeline={streamingProcessTimeline}
            isStreaming
            isStopping={isStopping}
            isAwaitingAction={isAwaitingAction}
            pendingActionKind={pendingActionKind}
            isRecovering={isRecovering}
            executionStage={runningMessage.executionStage}
            waitingStage={waitingStage}
            startTime={streamingStartTime}
            streamingSteps={streamingSteps}
            streamingBlocks={streamingBlocks}
            mobile={mobile}
            tokenUsage={streamingTokenUsage}
            onInteractionRespond={onInteractionRespond}
            onAsyncQuestionAnswer={onAsyncQuestionAnswer}
            answeredAsyncQuestionIds={answeredAsyncQuestionIds}
            asyncQuestionAnswers={asyncQuestionAnswers}
            canAnswerAsyncQuestion={canAnswerAsyncQuestion}
            onResync={onResync}
          />
          )}

          {latestMessagesRefreshStatus !== 'idle' && !runningMessage.show && (
            <LatestMessageRefreshBubble
              status={latestMessagesRefreshStatus}
              onRetry={onRetryLatestMessages}
            />
          )}
        </div>
      </div>

      {showScrollToBottom && !searchTargetMessageId && (
        <Tooltip content={processLayoutPaused ? '回到底部并恢复跟随' : '滚动到底部'} className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
          <button
            type="button"
            onClick={scrollToBottom}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--color-overlay-border)] bg-[var(--color-overlay-surface)] text-[var(--color-text-secondary)] shadow-[var(--color-overlay-shadow)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
            aria-label={processLayoutPaused ? '回到底部并恢复跟随' : '滚动到底部'}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 12.5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </Tooltip>
      )}
    </div>
  );
}
