import Tooltip from '../ui/Tooltip';
import FailureNotice from '../ui/FailureNotice';
import { useEffect, useState } from 'react';
import type { ProcessStep } from '../../stores/chat';
import { useSessionFollowupStore } from '../../stores/session-followups';
import ProcessActionIcon from './ProcessActionIcon';
import type { InteractionResponseHandler } from './InteractionPanel';

export type AsyncQuestionAnswerHandler = (questionId: string, content: string) => Promise<void>;

interface Props {
  step: ProcessStep;
  sessionId: string;
  answered: boolean;
  answerContent?: string;
  canAnswer: boolean;
  onAnswer?: AsyncQuestionAnswerHandler;
  onRespond?: InteractionResponseHandler;
  full?: boolean;
}

type Question = { title: string; options?: string[] };

export default function AsyncQuestionPanel({ step, sessionId, answered, answerContent, canAnswer, onAnswer, onRespond, full }: Props) {
  const followup = useSessionFollowupStore((state) => state.bySession[sessionId]?.find((item) => item.replyToAsyncQuestionId === step.id && item.state !== 'cancelled'));
  const details = step.details as Record<string, unknown>;
  const questions = (Array.isArray(details.questions) ? details.questions : []) as Question[];
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ''));
  const closed = details.resolvedAction === 'cancel';
  const [expanded, setExpanded] = useState(() => !answered && !closed);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const resolved = answered || closed;
  const answerSubmitted = Boolean(followup);
  const deliveryLabel = followup ? ({
    received: '已收到', steering: '正在加入当前任务', steered: '已加入当前任务',
    queued: '等待下一轮', dispatching: '正在启动下一轮', delivered: '已启动下一轮',
    paused: '已暂停', uncertain: '交付结果不确定', cancelled: '已取消',
  } as const)[followup.state] : null;
  const effectiveExpanded = full || expanded;

  useEffect(() => {
    if (resolved || answerSubmitted) setExpanded(false);
  }, [resolved, answerSubmitted]);

  const submit = async (closing = false) => {
    if (submitting || !canAnswer || (closing ? !onRespond : !onAnswer || answers.some((answer) => !answer.trim()))) return;
    setSubmitting(true);
    setError('');
    try {
      if (closing) {
        const result = await onRespond!(step.id, 'cancel');
        if (result.outcome !== 'accepted') throw new Error(result.message || '关闭失败，请重试');
        setExpanded(false);
      } else {
        const content = questions.length === 1 ? answers[0].trim()
          : questions.map((question, index) => `${index + 1}. ${question.title}\n${answers[index].trim()}`).join('\n\n');
        await onAnswer!(step.id, content);
      }
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '提交失败，请重试'); }
    finally { setSubmitting(false); }
  };

  return <section
    data-interaction-id={step.id}
    tabIndex={-1}
    aria-busy={submitting}
    className={`interaction-card interaction-card--${resolved ? 'resolved' : 'pending'} interaction-panel my-0.5 last:mb-1.5 overflow-hidden rounded-lg border outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]`}
  >
    <button
      type="button"
      onClick={() => setExpanded((value) => !value)}
      aria-expanded={effectiveExpanded}
      className="interaction-card__header flex w-full min-w-0 cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]"
    >
      <svg width="9" height="9" viewBox="0 0 12 12" fill="none" className={`shrink-0 transition-transform ${effectiveExpanded ? '' : '-rotate-90'}`} aria-hidden="true">
        <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="shrink-0 text-[var(--color-status-warning)]"><ProcessActionIcon kind="question" /></span>
      <span className="shrink-0 rounded border border-[var(--color-status-warning)]/30 px-1 py-0.5 text-[9px] leading-none text-[var(--color-status-warning)]">Codex 提问</span>
      <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-text)]">{questions[0]?.title || '需要回答'}</span>
      <span className="interaction-card__result shrink-0 text-[var(--color-text-tertiary)]">{answered ? '已回答' : closed ? '已关闭' : deliveryLabel || '等待回答'}</span>
    </button>

    {effectiveExpanded && <div className="interaction-card__body border-t border-[var(--color-border-light)] px-2.5 py-2" data-search-content>
      {resolved || answerSubmitted ? <div className="space-y-2 text-xs">
        {questions.map((question, index) => <div key={index}>
          <p className="font-medium text-[var(--color-text)]">{question.title}</p>
          {question.options?.length ? <p className="mt-1 text-[var(--color-text-tertiary)]">选项：{question.options.join(' / ')}</p> : null}
        </div>)}
        {(answered || followup) && <p className="whitespace-pre-wrap break-words text-[var(--color-text-secondary)]">回答：{answerContent || followup?.content || '已提交'}</p>}
      </div> : <div className="interaction-form interaction-form--user-input space-y-4">
        {questions.map((question, index) => <fieldset key={index} className="interaction-field space-y-2">
          <legend className="text-xs font-medium text-[var(--color-text)]">{question.title}</legend>
          {question.options?.length ? <div className="space-y-1.5">{question.options.map((option) => <label key={option} className="interaction-choice flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border-light)] px-3 py-2 text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]">
            <input type="radio" name={`${step.id}:${index}`} checked={answers[index] === option} onChange={() => setAnswers((current) => current.map((value, at) => at === index ? option : value))} className="accent-[var(--color-status-processing)]" />{option}
          </label>)}</div> : null}
          <input type="text" aria-label={question.title} enterKeyHint="done" value={answers[index] && question.options?.includes(answers[index]) ? '' : answers[index] || ''} onChange={(event) => setAnswers((current) => current.map((value, at) => at === index ? event.target.value : value))} placeholder={question.options?.length ? '其他回答' : '输入回答'} className="interaction-control w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]" />
        </fieldset>)}
        {!onAnswer
          ? <p className="text-xs text-[var(--color-text-secondary)]">仅会话所有人可回答</p>
          : !canAnswer && <p className="text-xs text-[var(--color-text-secondary)]">当前无法回答</p>}
        {error && <p role="alert" className="interaction-error text-xs text-[var(--color-status-danger)]"><FailureNotice error={error} /></p>}
        {onAnswer && <div className="interaction-card__actions flex justify-end gap-2">
          {onRespond && <Tooltip content="所有设备关闭，不再提醒" asChild><button type="button" disabled={submitting || !canAnswer} onClick={() => void submit(true)} className="interaction-action interaction-action--secondary rounded-lg px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">关闭问题</button></Tooltip>}
          <button type="button" disabled={!canAnswer || submitting || answers.some((answer) => !answer.trim())} onClick={() => void submit()} className="interaction-action interaction-action--primary rounded-lg bg-[var(--color-text)] px-3 py-1.5 text-xs text-[var(--color-bg)] disabled:opacity-40">{submitting ? '提交中…' : '提交回答'}</button>
        </div>}
      </div>}
    </div>}
  </section>;
}
