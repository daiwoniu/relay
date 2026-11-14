import { useEffect, useRef, useState } from 'react';
import { getBlankProcessingPresentation } from '../../hooks/processing-resync';

interface Props {
  startTime?: number | null;
  onResync?: () => void;
}

export default function BlankProcessingStatus({ startTime, onResync }: Props) {
  const fallbackStartTimeRef = useRef(Date.now());
  const effectiveStartTime = startTime || fallbackStartTimeRef.current;
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - effectiveStartTime));
  const [resyncing, setResyncing] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const update = () => setElapsedMs(Math.max(0, Date.now() - effectiveStartTime));
    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [effectiveStartTime]);

  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);

  const presentation = getBlankProcessingPresentation(elapsedMs);
  const handleResync = () => {
    if (!onResync || resyncing) return;
    setResyncing(true);
    onResync();
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null;
      setResyncing(false);
    }, 1_500);
  };

  if (elapsedMs < 8_000) return null;

  return (
    <span className="message-inline-feedback message-inline-feedback--delayed inline-flex flex-wrap items-center gap-1.5 font-normal text-[var(--color-text-tertiary)]">
      <span aria-hidden="true">·</span>
      <span>{presentation.message}</span>
      {presentation.allowManualResync && onResync && (
        <button
          type="button"
          onClick={handleResync}
          disabled={resyncing}
          className="message-inline-feedback__action"
        >
          {resyncing ? '正在同步…' : '重新同步'}
        </button>
      )}
    </span>
  );
}
