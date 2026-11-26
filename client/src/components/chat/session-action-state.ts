import type { SessionStatus } from '../../generated/relay-contracts';
import { isActiveTurnStatus } from '../../hooks/session-streaming.ts';

export function isSessionActionInProgress(status: SessionStatus): boolean {
  return status === 'queued' || isActiveTurnStatus(status);
}
