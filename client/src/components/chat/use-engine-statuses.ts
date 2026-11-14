import { useCallback, useEffect, useRef, useState } from 'react';
import { getEngineStatuses } from '../../api/system';
import type { EngineStatusDto } from '../../generated/relay-contracts';

const ENGINE_STATUS_RETRY_DELAYS_MS = [1_000, 3_000] as const;

export function useEngineStatuses() {
  const [engineStatuses, setEngineStatuses] = useState<EngineStatusDto[]>([]);
  const [engineStatusState, setEngineStatusState] = useState<'loading' | 'ready' | 'error'>('loading');
  const requestGenerationRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingRequest = useCallback(() => {
    requestGenerationRef.current += 1;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const refreshEngineStatuses = useCallback(() => {
    cancelPendingRequest();
    const generation = requestGenerationRef.current;
    setEngineStatusState('loading');
    const load = (attempt: number) => {
      void getEngineStatuses().then((response) => {
        if (requestGenerationRef.current !== generation) return;
        setEngineStatuses(response.engines);
        setEngineStatusState('ready');
      }).catch(() => {
        if (requestGenerationRef.current !== generation) return;
        const retryDelay = ENGINE_STATUS_RETRY_DELAYS_MS[attempt];
        if (retryDelay !== undefined) {
          retryTimerRef.current = setTimeout(() => load(attempt + 1), retryDelay);
          return;
        }
        setEngineStatuses([]);
        setEngineStatusState('error');
      });
    };
    load(0);
  }, [cancelPendingRequest]);

  const applyEngineStatusSnapshot = useCallback((statuses: EngineStatusDto[]) => {
    cancelPendingRequest();
    setEngineStatuses(statuses);
    setEngineStatusState('ready');
  }, [cancelPendingRequest]);

  useEffect(() => {
    refreshEngineStatuses();
    window.addEventListener('online', refreshEngineStatuses);
    return () => {
      window.removeEventListener('online', refreshEngineStatuses);
      cancelPendingRequest();
    };
  }, [cancelPendingRequest, refreshEngineStatuses]);

  return { engineStatuses, engineStatusState, applyEngineStatusSnapshot };
}
