import type { SessionDto } from '../generated/relay-contracts.ts';

export const MAX_BACKGROUND_SESSION_SUBSCRIPTIONS = 8;

const LIVE_BACKGROUND_STATUSES = new Set<SessionDto['status']>([
  'pending',
  'processing',
  'recovering',
  'awaiting_action',
  'stopping',
]);

interface SubscriptionPolicyInput {
  activeSessionId: string | null;
  sessions: Array<Pick<SessionDto, 'id' | 'status' | 'updated_at'>>;
  lastFocusedAt: ReadonlyMap<string, number>;
  maxBackground?: number;
}

export function selectLiveSessionSubscriptions({
  activeSessionId,
  sessions,
  lastFocusedAt,
  maxBackground = MAX_BACKGROUND_SESSION_SUBSCRIPTIONS,
}: SubscriptionPolicyInput): string[] {
  const background = sessions
    .filter((session) => session.id !== activeSessionId && LIVE_BACKGROUND_STATUSES.has(session.status))
    .sort((left, right) => {
      const leftApproval = left.status === 'awaiting_action' ? 1 : 0;
      const rightApproval = right.status === 'awaiting_action' ? 1 : 0;
      if (leftApproval !== rightApproval) return rightApproval - leftApproval;
      const recency = (lastFocusedAt.get(right.id) ?? right.updated_at)
        - (lastFocusedAt.get(left.id) ?? left.updated_at);
      return recency || left.id.localeCompare(right.id);
    })
    .slice(0, Math.max(0, maxBackground))
    .map((session) => session.id);
  return activeSessionId ? [activeSessionId, ...background] : background;
}
