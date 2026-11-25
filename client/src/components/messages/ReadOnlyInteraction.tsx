import type { ReactNode } from 'react';
import { featureAction } from '../../analytics/features';
import type { ProcessStep } from '../../stores/chat';
import ApprovalDetails from '../authorization/ApprovalDetails';
import { getApprovalResultLabel } from './interaction-model';
import { isPendingProcessInteraction } from './process-step-status';

export default function ReadOnlyInteraction({ step, settled, actions }: { step: ProcessStep; settled: boolean; actions?: ReactNode }) {
  const details = step.details;
  const pending = !settled && isPendingProcessInteraction(step);
  const result = pending ? '等待操作'
    : details.resolvedAction === 'resolved_elsewhere' ? '引擎侧已结束'
    : getApprovalResultLabel(details) ?? '结果未记录';
  const source = details.decisionSource === 'session_trust' ? '会话信任规则'
    : details.decisionSource === 'project_trust' ? '项目信任规则' : details.decisionSource === 'user' ? '用户操作' : '';
  const title = typeof details.title === 'string' && details.title.trim() ? details.title : '交互记录';
  const description = typeof details.message === 'string' ? details.message : '';
  return <details data-interaction-id={step.id} className="group/interaction process-group overflow-hidden rounded-lg border border-[var(--color-border-light)] text-xs text-[var(--color-text-secondary)]">
    <summary className="process-group__main flex min-w-0 cursor-pointer list-none items-center gap-1.5 hover:bg-[var(--color-surface-hover)] focus-visible:outline-offset-[-2px]"
      onClick={event => featureAction('interaction', event.currentTarget.closest('details')?.open ? 'collapse' : 'expand', 'message')}>
      <svg width="9" height="9" viewBox="0 0 12 12" fill="none" className="shrink-0 -rotate-90 transition-transform group-open/interaction:rotate-0" aria-hidden="true">
        <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text)]">{title}</span>
      <span className={`shrink-0 text-[11px] ${pending ? 'text-[var(--color-status-warning)]' : 'text-[var(--color-text-tertiary)]'}`}>{result}</span>
    </summary>
    <div className="space-y-1 border-t border-[var(--color-border-light)] px-2 py-1.5">
      {source && <p>决定来源：{source}</p>}
      {description && <p className="whitespace-pre-wrap break-words">{description}</p>}
      <ApprovalDetails details={details} summary={title} />
      {pending && actions}
    </div>
  </details>;
}
