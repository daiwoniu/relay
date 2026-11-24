import FailureNotice from '../ui/FailureNotice';
import { useCallback, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import type { SessionDeletionImpactDto } from '../../generated/relay-contracts';
import type { Session } from '../../stores/chat';
import AuthorizationReminderLayer from '../authorization/AuthorizationReminderLayer';
import ErrorBoundary from '../ErrorBoundary';
import DetailsDialog from '../layout/DetailsDialog';
import SessionEndAttentionLayer from '../notifications/SessionEndAttentionLayer';
import QueueStartAttentionLayer from '../notifications/QueueStartAttentionLayer';
import ResourceDeletionNotice from '../notifications/ResourceDeletionNotice';
import ShareCreateDialog, { type ShareDraft } from '../sharing/ShareCreateDialog';
import ShareSelectionBar from '../sharing/ShareSelectionBar';
import ServiceConnectionAlert from '../system/ServiceConnectionAlert';
import ConfirmDialog from '../ui/ConfirmDialog';
import ContextMenuPopup from '../ui/ContextMenu';
import ChatHeader from './ChatHeader';
import ChatInput from './ChatInput';
import CreateSessionFromContextDialog from './CreateSessionFromContextDialog';
import type { ChatContentState } from './chat-initialization-state';
import CurrentSessionSearch from './CurrentSessionSearch';
import EmptyState from './EmptyState';
import MessageList from './MessageList';
import MessageRegionState from './MessageRegionState';

export interface ChatViewDeleteTarget {
  id: string;
  title: string;
  impact: SessionDeletionImpactDto | null;
  impactStatus: 'loading' | 'ready' | 'unavailable';
}

interface SearchPresentationProps {
  query: string;
  status: ComponentProps<typeof CurrentSessionSearch>['status'];
  error: ComponentProps<typeof CurrentSessionSearch>['error'];
  historyStatus: ComponentProps<typeof CurrentSessionSearch>['historyStatus'];
  currentIndex: number;
  loadedMatchCount: number;
  totalMatches: number;
  truncated: boolean;
  includeProcess: boolean;
  includeOperations: boolean;
  mobile: boolean;
  onOpen: () => void;
  onQueryChange: (value: string) => void;
  onIncludeProcessChange: (value: boolean) => void;
  onIncludeOperationsChange: (value: boolean) => void;
  onPrevious: () => void;
  onNext: () => void;
  onRetry: () => void;
  onRetryHistory: () => void;
  onInputFocusChange: (focused: boolean) => void;
  onClose: () => void;
}

interface HeaderRegionProps {
  setActiveSession: ComponentProps<typeof AuthorizationReminderLayer>['setActiveSession'];
  respondToInteraction: ComponentProps<typeof AuthorizationReminderLayer>['respondToInteraction'];
  headerProps: Omit<ComponentProps<typeof ChatHeader>, 'searchOverlay' | 'searchTrigger'>;
  search: SearchPresentationProps;
  titleMenuProps: ComponentProps<typeof ContextMenuPopup>;
  mismatch: ComponentProps<typeof ServiceConnectionAlert>['mismatch'] | null;
  connectionError: string | null;
  onReconnect: () => void;
}

export function ChatViewHeaderRegion({ setActiveSession, respondToInteraction, headerProps, search, titleMenuProps, mismatch, connectionError, onReconnect }: HeaderRegionProps) {
  const commonSearchProps = {
    query: search.query,
    status: search.status,
    error: search.error,
    historyStatus: search.historyStatus,
    currentIndex: search.currentIndex,
    loadedMatchCount: search.loadedMatchCount,
    totalMatches: search.totalMatches,
    truncated: search.truncated,
    includeProcess: search.includeProcess,
    includeOperations: search.includeOperations,
    mobile: search.mobile,
    onOpen: search.onOpen,
    onQueryChange: search.onQueryChange,
    onIncludeProcessChange: search.onIncludeProcessChange,
    onIncludeOperationsChange: search.onIncludeOperationsChange,
    onPrevious: search.onPrevious,
    onNext: search.onNext,
    onRetry: search.onRetry,
    onRetryHistory: search.onRetryHistory,
    onInputFocusChange: search.onInputFocusChange,
    onClose: search.onClose,
  };

  return (
    <>
      <AuthorizationReminderLayer setActiveSession={setActiveSession} respondToInteraction={respondToInteraction} />
      <SessionEndAttentionLayer setActiveSession={setActiveSession} />
      <QueueStartAttentionLayer setActiveSession={setActiveSession} />
      <ChatHeader
        {...headerProps}
        searchOverlay={(
          <div className="absolute left-2.5 right-2.5 top-1/2 z-10 -translate-y-1/2 sm:right-4">
            <CurrentSessionSearch open {...commonSearchProps} />
          </div>
        )}
        searchTrigger={(
          <CurrentSessionSearch
            {...commonSearchProps}
            open={false}
            query=""
            status="idle"
            error={null}
            historyStatus="idle"
            currentIndex={-1}
            loadedMatchCount={0}
            totalMatches={0}
            truncated={false}
            onPrevious={() => undefined}
            onNext={() => undefined}
            onRetry={() => undefined}
            onRetryHistory={() => undefined}
            onInputFocusChange={() => undefined}
          />
        )}
      />

      <ContextMenuPopup {...titleMenuProps} />

      {mismatch ? (
        <ServiceConnectionAlert mismatch={mismatch} onReconnect={onReconnect} />
      ) : connectionError && (
        <div role="alert" className="mx-4 mt-3 rounded-lg border border-[var(--color-status-danger)]/30 bg-[var(--color-danger-hover)] px-3 py-2 text-sm text-[var(--color-status-danger)]">
          <FailureNotice error={connectionError} />
        </div>
      )}
      <ResourceDeletionNotice />
    </>
  );
}

interface MessageRegionProps {
  chatInitializationState: ChatContentState;
  hasMessages: boolean;
  recentSessions: readonly Session[];
  onOpenRecentSession: (id: string) => void;
  messageListKey: string | null;
  messageListProps: ComponentProps<typeof MessageList>;
  messageError: string | null | undefined;
  onRetry: () => void;
}

export function ChatViewMessageRegion({ chatInitializationState, hasMessages, recentSessions, onOpenRecentSession, messageListKey, messageListProps, messageError, onRetry }: MessageRegionProps) {
  return (
    <ErrorBoundary>
      {chatInitializationState === 'ready' && hasMessages ? (
        <MessageList key={messageListKey} {...messageListProps} />
      ) : chatInitializationState === 'restoring_location' || chatInitializationState === 'loading_messages' ? (
        <MessageRegionState state={chatInitializationState} onRetry={onRetry} />
      ) : chatInitializationState === 'message_error' ? (
        <MessageRegionState state="message_error" error={messageError} onRetry={onRetry} />
      ) : (
        <EmptyState recentSessions={recentSessions} onOpenRecentSession={onOpenRecentSession} />
      )}
    </ErrorBoundary>
  );
}

interface ComposerRegionProps {
  shareSelectionMode: boolean;
  shareSelectionProps: ComponentProps<typeof ShareSelectionBar>;
  keepComposerBehindSearchKeyboard: boolean;
  chatInputProps: ComponentProps<typeof ChatInput>;
}

export function ChatViewComposerRegion({ shareSelectionMode, shareSelectionProps, keepComposerBehindSearchKeyboard, chatInputProps }: ComposerRegionProps) {
  const composerRef = useRef<HTMLDivElement>(null);
  const [compactHeight, setCompactHeight] = useState(0);
  const { expanded, onExpandedChange } = chatInputProps;
  const handleExpandedChange = useCallback((nextExpanded: boolean) => {
    if (nextExpanded) setCompactHeight(composerRef.current?.offsetHeight ?? 0);
    onExpandedChange(nextExpanded);
  }, [onExpandedChange]);

  if (shareSelectionMode) return <ShareSelectionBar {...shareSelectionProps} />;

  return (
    <>
      {/* Keep the message list viewport stable while the composer overlays it. */}
      {expanded && <div aria-hidden="true" className="shrink-0" style={{ height: compactHeight }} />}
      <div
        ref={composerRef}
        data-search-keyboard-composer={keepComposerBehindSearchKeyboard ? 'behind' : 'visible'}
        className={keepComposerBehindSearchKeyboard ? 'pointer-events-none absolute inset-x-0 top-full' : expanded ? 'absolute inset-0' : 'shrink-0'}
      >
        <ChatInput {...chatInputProps} onExpandedChange={handleExpandedChange} />
      </div>
    </>
  );
}

interface DialogsProps {
  shareDraft: ShareDraft | null;
  onCloseShare: () => void;
  shareUnavailableOpen: boolean;
  onCloseShareUnavailable: () => void;
  mobileDetailsOpen: boolean;
  hasCurrentSession: boolean;
  currentSessionDetails: ReactNode;
  onCloseMobileDetails: () => void;
  deleteTarget: ChatViewDeleteTarget | null;
  onCancelDelete: () => void;
  onConfirmDelete: () => Promise<void>;
  deletePendingLabel: string;
  createSessionTarget: { sourceTitle: string; fromReply: boolean } | null;
  onCancelCreateSession: () => void;
  onConfirmCreateSession: () => Promise<void>;
}

export function ChatViewDialogs({ shareDraft, onCloseShare, shareUnavailableOpen, onCloseShareUnavailable, mobileDetailsOpen, hasCurrentSession, currentSessionDetails, onCloseMobileDetails, deleteTarget, onCancelDelete, onConfirmDelete, deletePendingLabel, createSessionTarget, onCancelCreateSession, onConfirmCreateSession }: DialogsProps) {
  return (
    <>
      <ShareCreateDialog draft={shareDraft} onClose={onCloseShare} />

      <ConfirmDialog
        open={shareUnavailableOpen}
        eyebrow="分享提示"
        title="暂时无法分享"
        tone="neutral"
        description="当前会话还没有可分享的已完成助手回复。请等待助手回复完成后再试。"
        cancelLabel={null}
        confirmLabel="知道了"
        onCancel={onCloseShareUnavailable}
        onConfirm={onCloseShareUnavailable}
      />

      <DetailsDialog open={mobileDetailsOpen && hasCurrentSession} onClose={onCloseMobileDetails} title="会话详情">
        {currentSessionDetails}
      </DetailsDialog>

      <CreateSessionFromContextDialog
        open={createSessionTarget !== null}
        sourceTitle={createSessionTarget?.sourceTitle}
        fromReply={createSessionTarget?.fromReply ?? false}
        onCancel={onCancelCreateSession}
        onConfirm={onConfirmCreateSession}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除会话"
        tone="danger"
        description={deleteTarget?.impactStatus === 'loading'
          ? '正在确认会话删除的影响范围…'
          : deleteTarget?.impactStatus === 'unavailable'
            ? '暂时无法确认会话删除的影响范围，请取消后重试。'
            : '请确认要删除的会话。'}
        subject={deleteTarget ? { label: '将删除会话', value: deleteTarget.title } : undefined}
        impacts={deleteTarget?.impactStatus === 'ready' && deleteTarget.impact?.hasLinkedCodexThread
          ? ['关联的 Codex 原始会话保留，归档状态不变', 'Relay 数据会移入回收站，可从回收站恢复']
          : ['Relay 数据会移入回收站，可从回收站恢复']}
        confirmLabel="删除"
        pendingLabel={deletePendingLabel}
        confirmDisabled={deleteTarget?.impactStatus !== 'ready'}
        onCancel={onCancelDelete}
        onConfirm={onConfirmDelete}
      />
    </>
  );
}
