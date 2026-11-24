import type { Session } from '../../stores/chat';

export function selectRecentSessions(
  sessions: readonly Session[],
  activeSessionId: string | null,
  ownerUserId?: string,
): Session[] {
  if (activeSessionId) return [];
  return sessions
    .filter(session => !session.codex_archived && (session.message_count ?? 0) > 0 && (!ownerUserId || session.owner?.id === ownerUserId))
    .sort((left, right) => right.updated_at - left.updated_at)
    .slice(0, 2);
}
