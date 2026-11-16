import type { ProcessStep } from '../../stores/chat';
import { getApprovalResultLabel } from './interaction-model';

export default function ReadOnlyInteraction({ step }: { step: ProcessStep }) {
  const details = step.details;
  const text = (value: unknown) => typeof value === 'string' ? value : '';
  const result = getApprovalResultLabel(details) || '结果未记录';
  const source = details.decisionSource === 'session_trust' ? '会话信任规则'
    : details.decisionSource === 'project_trust' ? '项目信任规则' : details.decisionSource === 'user' ? '用户操作' : details.decisionSource ? '来源未记录' : '';
  return <section className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs leading-5 text-[var(--color-text-secondary)]">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-[var(--color-text)]">{text(details.title) || '交互记录'}</span><span>{result}</span></div>
    {source && <p>决策来源：{source}</p>}
    {text(details.reason) && <p className="whitespace-pre-wrap break-words">{text(details.reason)}</p>}
    {text(details.command) && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all">{text(details.command)}</pre>}
    <p className="mt-1 text-[var(--color-text-tertiary)]">只读记录，不提供授权或回答操作。</p>
  </section>;
}
