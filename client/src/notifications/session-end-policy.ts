import type { SessionDto, SessionStatus } from '../generated/relay-contracts.ts';

export type SessionEndStatus = Extract<SessionStatus, 'completed' | 'failed' | 'stopped' | 'interrupted'>;

export interface SessionEndAttentionEvent {
  sequence: number;
  userId: string;
  sessionId: string;
  sessionTitle: string;
  status: SessionEndStatus;
  occurredAt: number;
  resultMessageId?: string;
}

const RUNNING_STATUSES = new Set<SessionStatus>(['queued', 'pending', 'processing', 'recovering', 'awaiting_action', 'stopping']);
const END_STATUSES = new Set<SessionStatus>(['completed', 'failed', 'stopped', 'interrupted']);

export function isLiveSessionEndTransition(previousStatus: SessionStatus | undefined, nextStatus: SessionStatus): nextStatus is SessionEndStatus {
  return Boolean(previousStatus && RUNNING_STATUSES.has(previousStatus) && END_STATUSES.has(nextStatus));
}

export function createSessionEndAttentionEvent(previousStatus: SessionStatus | undefined, session: SessionDto, userId: string, options: { snapshot?: boolean; previousResultMessageId?: string } = {}): Omit<SessionEndAttentionEvent, 'sequence'> | null {
  if (options.snapshot || (session.last_result && session.last_result.messageId === options.previousResultMessageId)) return null;
  if (!isLiveSessionEndTransition(previousStatus, session.status)) return null;
  return {
    userId,
    sessionId: session.id,
    sessionTitle: session.title || '未命名会话',
    status: session.status,
    occurredAt: session.last_result?.createdAt ?? session.updated_at,
    ...(session.last_result ? { resultMessageId: session.last_result.messageId } : {}),
  };
}

export function getSessionEndAttentionDecision(input: {
  pageVisible: boolean;
  windowFocused: boolean;
  activeSessionId: string | null;
  eventSessionId: string;
  systemEnabled: boolean;
  systemSupported: boolean;
  systemPermission: NotificationPermission | 'unsupported';
  soundEnabled: boolean;
}) {
  const alreadyAttending = input.pageVisible && input.windowFocused && input.activeSessionId === input.eventSessionId;
  return {
    sendSystemNotification: !alreadyAttending && input.systemEnabled && input.systemSupported && input.systemPermission === 'granted',
    playSound: !alreadyAttending && input.soundEnabled,
  };
}
