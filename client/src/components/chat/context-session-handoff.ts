export const CONTEXT_SESSION_HANDOFF_REQUEST = '请为切换到新会话整理一份自包含的任务交接摘要。优先控制在 800 个中文字符以内；仅当任务涉及多仓库、发布、线上环境或复杂未决事项时，可放宽至 1200 个中文字符。必须包含：目标、已完成、关键决策、修改文件、验证结果、未完成事项、下一步。以新会话能够直接继续工作为准，不为凑齐字段重复信息。只输出交接摘要，不要继续执行任务。';

interface ContextSessionHandoffMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  stopped?: boolean;
  isError?: boolean;
  outcome?: 'completed' | 'failed' | 'stopped' | 'interrupted';
  attachments?: unknown[];
}

export function findContextSessionHandoffSummary(
  messages: ContextSessionHandoffMessage[],
): string | null {
  const effectiveMessages = messages.filter((message) => message.role !== 'system');
  if (effectiveMessages.length < 2) return null;

  const request = effectiveMessages[effectiveMessages.length - 2];
  const response = effectiveMessages[effectiveMessages.length - 1];
  if (
    request?.role !== 'user'
    || request.content !== CONTEXT_SESSION_HANDOFF_REQUEST
    || response?.role !== 'assistant'
    || response.isError
    || response.stopped
    || (response.outcome && response.outcome !== 'completed')
  ) return null;

  const summary = response.content.trim();
  return summary || null;
}

export function buildContextSessionContinuationDraft(summary: string): string | null {
  const normalizedSummary = summary.trim();
  if (!normalizedSummary) return null;
  return `请继续处理上一会话的任务。以下是交接摘要，请先核查仓库实际状态，再从“下一步”继续，不要重复已完成工作。\n\n--- 交接摘要 ---\n${normalizedSummary}`;
}

export function hasContextSessionHandoffDraftConflict(
  draft: string,
  attachmentCount: number,
): boolean {
  return draft.trim().length > 0 || attachmentCount > 0;
}
