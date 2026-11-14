import type { RuntimeTurnItem } from '../engine/runtime.js';

type Question = { title: string; options?: string[] };

export function toAsyncQuestionItem(input: unknown): RuntimeTurnItem | null {
  if (!input || typeof input !== 'object') return null;
  const source = input as Record<string, unknown>;
  if (source.type !== 'agentMessage' || source.delivery !== 'async'
    || typeof source.id !== 'string' || !source.id) return null;
  if (!Array.isArray(source.questions) || source.questions.length === 0) return null;
  const questions: Question[] = [];
  for (const value of source.questions) {
    if (!value || typeof value !== 'object') return null;
    const question = value as Record<string, unknown>;
    if (typeof question.title !== 'string' || !question.title.trim()) return null;
    if (question.options !== null && question.options !== undefined
      && (!Array.isArray(question.options) || question.options.some((option) => typeof option !== 'string' || !option.trim()))) return null;
    questions.push({ title: question.title.trim(), ...(Array.isArray(question.options) ? { options: question.options } : {}) });
  }
  return {
    id: `async-question:${source.id}`,
    type: 'interaction',
    status: 'in_progress',
    details: {
      interactionKind: 'async_question',
      sourceItemId: source.id,
      title: questions[0].title,
      questions,
    },
  };
}

export function hasUnansweredAsyncQuestion(
  messages: Array<{ role: string; items: string | null; metadata: string | null }>,
  questionId: string,
): boolean {
  if (!questionId.startsWith('async-question:')) return false;
  let found = false;
  for (const message of messages) {
    if (message.role === 'assistant' && message.items) {
      try {
        const items: unknown = JSON.parse(message.items);
        if (Array.isArray(items) && items.some((item) => item && typeof item === 'object'
          && item.id === questionId && item.type === 'interaction'
          && item.details?.interactionKind === 'async_question')) found = true;
      } catch { /* Ignore old or damaged process details. */ }
    }
    if (message.role === 'user' && message.metadata) {
      try {
        const metadata = JSON.parse(message.metadata);
        if (metadata?.replyToAsyncQuestionId === questionId) return false;
      } catch { /* Ignore old or damaged metadata. */ }
    }
  }
  return found;
}

export function canSubmitAsyncQuestionAnswer(input: {
  ownerUserId: string | null;
  actorUserId: string;
  questionId: string;
  messageId?: string;
  history: Array<{ role: string; items: string | null; metadata: string | null }>;
  runtimeItems: RuntimeTurnItem[];
  followups: Array<{ id: string; replyToAsyncQuestionId: string | null; state: string }>;
}): boolean {
  if (!input.ownerUserId || input.ownerUserId !== input.actorUserId) return false;
  if (!input.questionId.startsWith('async-question:')) return false;
  if (input.followups.some((item) => item.replyToAsyncQuestionId === input.questionId
    && item.state !== 'cancelled' && item.id !== input.messageId)) return false;
  const live = input.runtimeItems.some((item) => item.id === input.questionId
    && item.type === 'interaction' && (item.details as Record<string, unknown> | undefined)?.interactionKind === 'async_question');
  return live || hasUnansweredAsyncQuestion(input.history, input.questionId);
}
