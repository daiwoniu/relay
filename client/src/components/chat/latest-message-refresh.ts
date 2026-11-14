export const LATEST_MESSAGE_LOADING_DELAY_MS = 250;
export const MESSAGE_RESUME_RECONNECT_THRESHOLD_MS = 30_000;
export const MESSAGE_INITIAL_REQUEST_TIMEOUT_MS = 10_000;

export type LatestMessageRefreshStatus = 'idle' | 'loading' | 'error';

interface LatestMessageTail {
  role: 'user' | 'assistant' | 'system';
}

export function isLatestMessageReplyMissing(messages: LatestMessageTail[]): boolean {
  if (messages.length === 0) return true;
  return messages[messages.length - 1].role === 'user';
}

export function getLatestMessageBubbleStatus(
  status: LatestMessageRefreshStatus,
  visible: boolean,
  sessionRunning: boolean,
  latestReplyMissing: boolean,
): LatestMessageRefreshStatus {
  if (sessionRunning || !visible) return 'idle';
  if (!latestReplyMissing) return 'idle';
  return status;
}

export function shouldReconnectAfterResume(
  hiddenAt: number | null,
  now: number,
  pageShowPersisted: boolean,
): boolean {
  if (pageShowPersisted) return true;
  return hiddenAt !== null && now - hiddenAt >= MESSAGE_RESUME_RECONNECT_THRESHOLD_MS;
}

export function shouldRefreshOnPageShow(pageShowPersisted: boolean): boolean {
  return pageShowPersisted;
}
