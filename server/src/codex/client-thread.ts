import { RELAY_FILE_CHANGE_REPORT_TOOL_SPEC } from '../messages/file-change-report.js';

export interface ThreadOpenRequest {
  method: 'thread/start' | 'thread/resume';
  params: Record<string, any>;
}

/** 根据持久化状态决定创建还是恢复 Codex thread。 */
export function buildThreadOpenRequest(threadId?: string | null, cwd?: string, modelId?: string | null): ThreadOpenRequest {
  // Enable the native progress tool for Relay sessions without changing user config.
  const params: Record<string, any> = { config: { 'tools.update_plan.enabled': true } };
  if (threadId) params.threadId = threadId;
  if (threadId) params.excludeTurns = true;
  if (cwd) params.cwd = cwd;
  if (!threadId && modelId) params.model = modelId;
  if (!threadId) params.dynamicTools = [RELAY_FILE_CHANGE_REPORT_TOOL_SPEC];
  return {
    method: threadId ? 'thread/resume' : 'thread/start',
    params,
  };
}

export function isArchivedThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /\bis archived\b/i.test(message) && /\bunarchive\b/i.test(message);
}

export function isNotificationForActiveThread(
  activeThreadId: string | null,
  notificationThreadId: unknown,
): boolean {
  return !activeThreadId
    || typeof notificationThreadId !== 'string'
    || !notificationThreadId
    || notificationThreadId === activeThreadId;
}
