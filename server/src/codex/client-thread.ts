import { RELAY_FILE_CHANGE_REPORT_TOOL_SPEC } from '../messages/file-change-report.js';

export interface ThreadOpenRequest {
  method: 'thread/start' | 'thread/resume';
  params: Record<string, any>;
}

export const feishuPermissionProfile = 'relay-feishu';

export function buildFeishuThreadOpenRequest(modelId?: string | null, mcpServerNames: readonly string[] = []): ThreadOpenRequest {
  return { method: 'thread/start', params: {
    ...(modelId ? { model: modelId } : {}),
    ephemeral: true, environments: [], runtimeWorkspaceRoots: [], dynamicTools: [],
    approvalPolicy: 'never', permissions: feishuPermissionProfile,
    config: {
      permissions: { [feishuPermissionProfile]: { filesystem: { ':minimal': 'read' }, network: { enabled: false } } },
      default_permissions: feishuPermissionProfile, web_search: 'disabled',
      'features.shell_tool': false, 'features.plugins': false, 'features.apps': false,
      'features.skill_mcp_dependency_install': false, project_doc_max_bytes: 0,
      mcp_servers: Object.fromEntries(mcpServerNames.map(name => [name, { enabled: false }])),
    },
    baseInstructions: '你是飞书聊天助手。仅根据用户消息、对话摘录和提供的工作区只读数据回答。直接输出正文。不要调用工具，不要声称执行命令或改动文件。',
  } };
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
