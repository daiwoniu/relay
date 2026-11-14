import FailureNotice from '../ui/FailureNotice';
import { useEffect, useMemo, useRef, useState } from 'react';
import ProcessActionIcon from './ProcessActionIcon';
import type { InteractionResponseResultEvent, RespondInteractionCommand } from '../../generated/relay-contracts';
import type { ProcessStep } from '../../stores/chat';
import {
  buildMcpDefaults,
  getApprovalResultLabel,
  getApprovalSourceLabel,
  getApprovalDecisionAvailability,
  isMcpFormComplete,
  isSupportedMcpForm,
} from './interaction-model';
import { getDeviceId } from '../../utils/device-id';
import ApprovalDetails from '../authorization/ApprovalDetails';
import { getApprovalPresentation } from '../authorization/approval-presentation.ts';
import {
  getInitialInteractionPanelExpanded,
  shouldAutoCollapseInteractionPanel,
} from './interaction-panel-state';
import McpElicitationForm from './McpElicitationForm';

type ResponseOptions = Pick<RespondInteractionCommand, 'answers' | 'formData'>;

export type InteractionResponseHandler = (
  interactionId: string,
  action: RespondInteractionCommand['action'],
  options?: ResponseOptions,
) => Promise<InteractionResponseResultEvent>;

interface Props {
  step: ProcessStep;
  onRespond?: InteractionResponseHandler;
  full?: boolean;
}

type Details = Record<string, any>;

function UserInputBody({ details, answers, setAnswers }: {
  details: Details;
  answers: Record<string, string[]>;
  setAnswers: (answers: Record<string, string[]>) => void;
}) {
  const questions = Array.isArray(details.questions) ? details.questions : [];
  return (
    <div className="interaction-form interaction-form--user-input space-y-4">
      {questions.length === 0 && <p className="text-xs text-[var(--color-text-secondary)]">Codex 没有提供具体问题，可以提交空回答继续，或取消本次请求。</p>}
      {questions.map((question: any, questionIndex: number) => {
        const options = Array.isArray(question.options) ? question.options : [];
        const value = answers[question.id]?.[0] || '';
        return (
          <fieldset key={question.id} className="interaction-field space-y-2">
            <legend className="text-xs font-medium text-[var(--color-text)]">{question.header || question.question}</legend>
            {question.header && <p className="text-xs text-[var(--color-text-secondary)]">{question.question}</p>}
            {options.length > 0 && (
              <div className="space-y-1.5">
                {options.map((option: any) => (
                  <label key={option.label} className="interaction-choice flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--color-border-light)] px-3 py-2 transition-colors hover:bg-[var(--color-surface-hover)]">
                    <input
                      type="radio"
                      name={`interaction-${question.id}`}
                      value={option.label}
                      checked={value === option.label}
                      onChange={() => setAnswers({ ...answers, [question.id]: [option.label] })}
                      className="mt-0.5 accent-[var(--color-status-processing)]"
                    />
                    <span className="min-w-0 text-xs">
                      <span className="block font-medium text-[var(--color-text)]">{option.label}</span>
                      {option.description && <span className="block text-[var(--color-text-tertiary)]">{option.description}</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {(options.length === 0 || question.isOther) && (
              <input
                type={question.isSecret ? 'password' : 'text'}
                value={options.length > 0 && value !== '__other__' && options.some((option: any) => option.label === value) ? '' : value}
                onChange={(event) => setAnswers({ ...answers, [question.id]: [event.target.value] })}
                enterKeyHint={questionIndex === questions.length - 1 ? 'done' : 'next'}
                placeholder={options.length > 0 ? '其他答案' : '请输入答案'}
                className="interaction-control w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
              />
            )}
          </fieldset>
        );
      })}
    </div>
  );
}

export default function InteractionPanel({ step, onRespond, full }: Props) {
  const details = step.details as Details;
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [formData, setFormData] = useState<Record<string, unknown>>(() => buildMcpDefaults(details));
  const [manualJson, setManualJson] = useState('{}');
  const [submitting, setSubmitting] = useState(false);
  const [responseError, setResponseError] = useState('');
  const pending = step.status === 'in_progress' && !details.resolvedAction;
  const [expanded, setExpanded] = useState(() => getInitialInteractionPanelExpanded(pending));
  const effectiveExpanded = full || expanded;
  const wasPendingRef = useRef(pending);
  const kind = String(details.interactionKind || 'unsupported_request');
  const approvalPresentation = kind === 'command_approval' || kind === 'file_approval' || kind === 'permissions_approval'
    ? getApprovalPresentation({ kind, fallbackTitle: String(details.title || ''), details })
    : null;
  const approvalAvailability = useMemo(() => getApprovalDecisionAvailability(details), [details]);
  const decisionSourceLabel = getApprovalSourceLabel(details, getDeviceId() || null);
  const resolvedActionLabel = getApprovalResultLabel(details);
  const approvalHasVisibleActions = approvalAvailability.accept
    || approvalAvailability.acceptForSession
    || approvalAvailability.decline;
  const mcpSupported = useMemo(() => isSupportedMcpForm(details), [details]);
  const manualJsonResult = useMemo(() => {
    try {
      const value: unknown = JSON.parse(manualJson);
      return value && typeof value === 'object' && !Array.isArray(value)
        ? { value: value as Record<string, unknown>, error: '' }
        : { value: null, error: '请输入 JSON 对象' };
    } catch {
      return { value: null, error: 'JSON 格式不正确' };
    }
  }, [manualJson]);
  const mcpCanSubmit = details.mode === 'url'
    || (mcpSupported ? isMcpFormComplete(details, formData) : Boolean(manualJsonResult.value));
  const canSubmit = useMemo(() => {
    if (kind !== 'user_input') return true;
    const questions = Array.isArray(details.questions) ? details.questions : [];
    return questions.every((question: any) => (answers[question.id]?.[0] || '').trim());
  }, [answers, details.questions, kind]);

  useEffect(() => {
    if (pending) {
      setExpanded(true);
    } else if (shouldAutoCollapseInteractionPanel(wasPendingRef.current, pending)) {
      setExpanded(false);
    }
    wasPendingRef.current = pending;
  }, [pending]);

  const respond = async (action: RespondInteractionCommand['action'], options?: ResponseOptions) => {
    if (!onRespond || submitting) return;
    setSubmitting(true);
    setResponseError('');
    try {
      await onRespond(step.id, action, options);
      setExpanded(false);
    } catch (error) {
      setSubmitting(false);
      setResponseError(error instanceof Error ? error.message : '提交操作失败');
    }
  };

  return (
    <section
      data-interaction-id={step.id}
      tabIndex={-1}
      aria-busy={submitting}
      className={`interaction-card interaction-card--${pending ? 'pending' : 'resolved'} interaction-panel border outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] ${pending
        ? 'my-1 rounded-xl p-3'
        : 'my-0.5 last:mb-1.5 overflow-hidden rounded-lg'}`}
      aria-label={approvalPresentation
        ? `${approvalPresentation.typeLabel}：${approvalPresentation.purpose}`
        : String(details.title || '需要操作')}
    >
      <button
        type="button"
        disabled={pending}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={pending ? undefined : effectiveExpanded}
        className={`interaction-card__header ${pending
          ? 'flex w-full cursor-default items-start justify-between gap-3 text-left'
          : 'flex w-full min-w-0 cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]'}`}
      >
        {pending ? (
          <>
            <span className="flex min-w-0 items-start gap-2">
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-medium text-[var(--color-text)]">
                  <span className="text-[var(--color-status-warning)]"><ProcessActionIcon kind={approvalPresentation ? 'approval' : 'question'} /></span>
                  {approvalPresentation ? <><span className="shrink-0 rounded border border-[var(--color-status-warning)]/30 px-1 py-0.5 text-[10px] leading-none text-[var(--color-status-warning)]">{approvalPresentation.typeLabel}</span><span className="min-w-0 truncate sm:overflow-visible sm:whitespace-normal sm:text-clip sm:break-words">{approvalPresentation.purpose}</span></> : (details.title || '需要你的操作')}
                </span>
                {details.serverName && <span className="mt-0.5 block text-[11px] text-[var(--color-text-tertiary)]">来源：{String(details.serverName)}</span>}
              </span>
            </span>
            <span className="shrink-0 text-[11px] text-[var(--color-status-warning)]">{submitting ? '正在提交…' : onRespond ? '等待操作' : '等待会话端处理'}</span>
          </>
        ) : (
          <>
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none" className={`shrink-0 transition-transform ${effectiveExpanded ? '' : '-rotate-90'}`} aria-hidden="true">
              <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="shrink-0 text-[var(--color-status-warning)]"><ProcessActionIcon kind={approvalPresentation ? 'approval' : 'question'} /></span>
            {approvalPresentation && <span className="shrink-0 rounded border border-[var(--color-status-warning)]/30 px-1 py-0.5 text-[9px] leading-none text-[var(--color-status-warning)]">{approvalPresentation.typeLabel}</span>}
            <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text)]">{approvalPresentation?.purpose || details.title || '需要你的操作'}</span>
            <span className="interaction-card__result shrink-0 text-[var(--color-text-tertiary)]">{resolvedActionLabel}</span>
          </>
        )}
      </button>

      {effectiveExpanded && <div className={`interaction-card__body ${pending ? 'mt-3' : 'border-t border-[var(--color-border-light)] px-2.5 py-2'}`}>
        {!pending && details.serverName && <div className="mb-2 text-[11px] text-[var(--color-text-tertiary)]">来源：{String(details.serverName)}</div>}
        {!pending && decisionSourceLabel && <div className="mb-2 text-[11px] text-[var(--color-text-tertiary)]">决定来源：{decisionSourceLabel}</div>}
        {(kind === 'command_approval' || kind === 'file_approval' || kind === 'permissions_approval') && <ApprovalDetails details={details} />}
        {kind === 'user_input' && <UserInputBody details={details} answers={answers} setAnswers={setAnswers} />}
        {kind === 'mcp_elicitation' && (
          <>
            <McpElicitationForm
              details={details}
              formData={formData}
              setFormData={setFormData}
              manualJson={manualJson}
              setManualJson={setManualJson}
              supported={mcpSupported}
            />
            {!mcpSupported && manualJsonResult.error && <p className="interaction-error mt-2 text-xs text-[var(--color-status-danger)]">{manualJsonResult.error}</p>}
          </>
        )}
        {kind === 'unsupported_request' && <p className="text-xs text-[var(--color-text-secondary)]">Relay 暂时无法识别此请求：{String(details.method || '')}</p>}
        {responseError && <p role="alert" className="interaction-error mt-2 text-xs text-[var(--color-status-danger)]"><FailureNotice error={responseError} /></p>}

        {pending && onRespond && (
        <div className="interaction-card__actions mt-3 flex flex-wrap justify-end gap-2 [&>button]:shrink-0 [&>button]:whitespace-nowrap">
          {kind === 'user_input' ? (
            <>
              <button type="button" disabled={submitting} onClick={() => respond('cancel')} className="interaction-action interaction-action--secondary rounded-lg px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">取消</button>
              <button type="button" disabled={submitting || !canSubmit} onClick={() => respond('submit', { answers })} className="interaction-action interaction-action--primary rounded-lg bg-[var(--color-text)] px-3 py-1.5 text-xs text-[var(--color-bg)] disabled:opacity-40">提交回答</button>
            </>
          ) : kind === 'mcp_elicitation' ? (
            <>
              <button
                type="button"
                disabled={submitting || !mcpCanSubmit}
                onClick={() => respond('submit', { formData: mcpSupported ? formData : manualJsonResult.value || {} })}
                className="interaction-action interaction-action--primary rounded-lg bg-[var(--color-text)] px-3 py-1.5 text-xs text-[var(--color-bg)] disabled:opacity-40"
              >继续</button>
              <button type="button" disabled={submitting} onClick={() => respond('decline')} className="interaction-action interaction-action--danger rounded-lg px-3 py-1.5 text-xs text-[var(--color-status-danger)]">拒绝</button>
            </>
          ) : kind === 'unsupported_request' ? null : (
            <>
              {!approvalHasVisibleActions && <span role="note" className="mr-auto text-xs leading-relaxed text-[var(--color-text-secondary)]">该请求未提供可用的授权操作，当前无法继续。请停止本轮后重试。</span>}
              {approvalAvailability.accept && <button type="button" disabled={submitting} onClick={() => respond('accept')} className="interaction-action interaction-action--primary rounded-lg bg-[var(--color-text)] px-3 py-1.5 text-xs text-[var(--color-bg)] disabled:opacity-40">允许一次</button>}
              {approvalAvailability.acceptForSession && <button type="button" disabled={submitting} onClick={() => respond('accept_for_session')} className="interaction-action interaction-action--secondary rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]">本会话允许</button>}
              {approvalAvailability.decline && <button type="button" disabled={submitting} onClick={() => respond('decline')} className="interaction-action interaction-action--danger rounded-lg px-3 py-1.5 text-xs text-[var(--color-status-danger)]">拒绝</button>}
            </>
          )}
        </div>
        )}
      </div>}
    </section>
  );
}
