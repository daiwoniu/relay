import type { SessionStatus } from '../contracts/index.js';

const IN_PROGRESS_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set([
  'queued',
  'pending',
  'processing',
  'recovering',
  'awaiting_action',
  'stopping',
]);

export function isSessionInProgress(status: string): boolean {
  return IN_PROGRESS_SESSION_STATUSES.has(status as SessionStatus);
}
