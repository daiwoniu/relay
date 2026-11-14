import type { SessionStatus } from '../../generated/relay-contracts';

const IN_PROGRESS_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set([
  'queued',
  'pending',
  'processing',
  'recovering',
  'awaiting_action',
  'stopping',
]);

export function isSessionActionInProgress(status: SessionStatus): boolean {
  return IN_PROGRESS_SESSION_STATUSES.has(status);
}
