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

export function getSessionInputState(
  status: SessionStatus | undefined,
  streaming: SessionStreamingState,
  sessionId: string | null,
): { isRunning: boolean; isStopping: boolean; isQueued: boolean } {
  const scoped = Boolean(sessionId && streaming.streamingSessionId === sessionId);
  return {
    isRunning: scoped
      ? streaming.isWaiting || streaming.isStreaming || streaming.isStopping
      : status === 'pending' || status === 'processing' || status === 'recovering' || status === 'awaiting_action' || status === 'stopping',
    isStopping: scoped ? streaming.isStopping : status === 'stopping',
    isQueued: status === 'queued',
  };
}
import type { SessionStatus } from '../generated/relay-contracts';
