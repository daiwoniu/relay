import type { ReactNode } from 'react';
import FailureNotice from '../ui/FailureNotice';

export type PreviewStateTone = 'empty' | 'loading' | 'warning' | 'danger';

export default function PreviewState({
  title,
  description,
  tone = 'empty',
  action,
  hidden = false,
  compact = false,
}: {
  title: string;
  description?: string;
  tone?: PreviewStateTone;
  action?: ReactNode;
  hidden?: boolean;
  compact?: boolean;
}) {
  return (
    <div
      className={`workspace-preview-state is-${tone}${compact ? ' is-compact' : ''}${hidden ? ' hidden' : ''}`}
      role={tone === 'loading' ? 'status' : undefined}
    >
      <span className="workspace-preview-state__icon" aria-hidden="true">
        {tone === 'loading' ? (
          <svg viewBox="0 0 24 24" fill="none" className="workspace-preview-state__spinner"><circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" opacity="0.25"/><path d="M20 12a8 8 0 00-8-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
        ) : tone === 'danger' || tone === 'warning' ? (
          <svg viewBox="0 0 24 24" fill="none"><path d="M12 3l9 16H3L12 3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M12 9v4.5M12 17h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none"><path d="M6 3.5h8l4 4v13H6v-17z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M14 3.5v4h4M9 12h6M9 15.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        )}
      </span>
      <div className="workspace-preview-state__copy">
        <div className="workspace-preview-state__title">{title}</div>
        {description && <div className="workspace-preview-state__description">{tone === 'danger' ? <FailureNotice error={description} /> : description}</div>}
      </div>
      {action && <div className="workspace-preview-state__action">{action}</div>}
    </div>
  );
}
