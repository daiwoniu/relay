import { useEffect } from 'react';
import type { SessionDto } from '../generated/relay-contracts';
import { useSessionReadStore } from '../stores/session-reads';
import { observeSessionResult } from '../utils/session-read-observer';

export function useSessionReadReceipt(session: SessionDto | undefined, messageLoaded: boolean, send: (sessionId: string, messageId: string) => boolean) {
  const resultId = session?.last_result?.messageId;
  const sessionId = session?.id;
  const receipts = useSessionReadStore((state) => state.receipts);
  useEffect(() => {
    if (!sessionId || !resultId || !messageLoaded || receipts[sessionId] === resultId) return;
    return observeSessionResult(resultId, () => send(sessionId, resultId));
  }, [sessionId, resultId, messageLoaded, receipts, send]);
}
