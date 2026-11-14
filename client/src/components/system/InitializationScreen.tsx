import { useEffect, useState } from 'react';
import FailureNotice from '../ui/FailureNotice';
import { getInitializationStagePresentation, INITIALIZATION_LOADING_DELAY_MS, type InitializationStage } from './initialization-screen';

interface Props {
  stage: InitializationStage;
  error?: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export default function InitializationScreen({ stage, error, onRetry, retryLabel = '重新加载' }: Props) {
  const presentation = getInitializationStagePresentation(stage);
  const [visible, setVisible] = useState(Boolean(error));

  useEffect(() => {
    if (error) {
      setVisible(true);
      return;
    }
    setVisible(false);
    const timer = window.setTimeout(() => setVisible(true), INITIALIZATION_LOADING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [error, stage]);

  if (!visible) return <div className="h-full min-h-0 bg-[var(--color-bg)]" aria-hidden="true" />;

  return (
    <div className="theme-region-section flex h-full min-h-0 items-center justify-center bg-[var(--color-bg)] px-4 text-[var(--color-text)]">
      <div className="w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 shadow-sm">
        <div className="flex items-start gap-3">
          {error ? (
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)] text-xs font-semibold text-[var(--color-status-warning)]" aria-hidden="true">!</span>
          ) : (
            <span className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-text)]" aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-[var(--color-text)]">{error ? <FailureNotice error={error} /> : presentation.title}</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">{presentation.detail}</p>
            {error && onRetry && (
              <button type="button" onClick={onRetry} className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]">
                {retryLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
