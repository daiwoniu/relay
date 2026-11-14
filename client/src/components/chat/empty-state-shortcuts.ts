import type { Session } from '../../stores/chat';

export function selectRecentSession(
  sessions: readonly Session[],
  activeSessionId: string | null,
  ownerUserId?: string,
): Session | null {
  return sessions.reduce<Session | null>((recent, session) => {
    if (session.id === activeSessionId || session.codex_archived || session.message_count === 0 || (ownerUserId && session.owner?.id !== ownerUserId)) return recent;
    if (!recent || session.updated_at > recent.updated_at) return session;
    return recent;
  }, null);
}
