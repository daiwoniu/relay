export interface SessionStreamingState {
  isWaiting: boolean;
  isStreaming: boolean;
  isStopping: boolean;
  streamingSessionId: string | null;
  currentContent: string;
}

export function isSessionRunning(streaming: SessionStreamingState, sessionId: string | null): boolean {
  return Boolean(
    sessionId
    && streaming.streamingSessionId === sessionId
    && (streaming.isWaiting || streaming.isStreaming || streaming.isStopping),
  );
}

export function getSessionStreamingContent(streaming: SessionStreamingState, sessionId: string | null): string {
  return streaming.streamingSessionId === sessionId ? streaming.currentContent : '';
}

export function getActiveSubscriptionSessionId(activeSessionId: string | null): string | null {
  return activeSessionId || null;
}

export function isActiveTurnStatus(status: SessionStatus | undefined): boolean {
  return status === 'pending' || status === 'processing' || status === 'recovering' || status === 'awaiting_action' || status === 'stopping';
}

export function getSessionInputState(
  status: SessionStatus | undefined,
  streaming: SessionStreamingState,
  sessionId: string | null,
): { isRunning: boolean; isStopping: boolean; isQueued: boolean } {
  const scoped = Boolean(sessionId && streaming.streamingSessionId === sessionId);
  const isStopping = status === 'stopping' || (scoped && streaming.isStopping);
  return {
    isRunning: scoped
      ? streaming.isWaiting || streaming.isStreaming || isStopping
      : isActiveTurnStatus(status),
    isStopping,
    isQueued: status === 'queued',
  };
}
import type { SessionStatus } from '../generated/relay-contracts';
