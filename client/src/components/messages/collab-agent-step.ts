interface CollabAgentResult {
  threadId: string;
  status: string;
  message?: string;
}

export interface CollabAgentStepInfo {
  action: string;
  title: string;
  fullTitle: string;
  metadata?: string[];
  output?: string;
}

export function isCollabAgentSubtask(details: Record<string, unknown>): boolean {
  const tool = toText(details.tool);
  return tool === 'spawnAgent'
    || Boolean(toText(details.name || details.agentName || details.prompt))
    || readAgentResults(details.agentResults).length > 0;
}

const TOOL_LABELS: Record<string, string> = {
  spawnAgent: '创建子任务',
  sendInput: '发送子任务消息',
  resumeAgent: '恢复子任务',
  wait: '等待子任务',
  closeAgent: '关闭子任务',
};

const STATUS_LABELS: Array<[string, string]> = [
  ['pendingInit', '初始化中'],
  ['running', '运行中'],
  ['completed', '已完成'],
  ['interrupted', '已中断'],
  ['errored', '失败'],
  ['shutdown', '已关闭'],
  ['notFound', '未找到'],
];

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readAgentResults(value: unknown): CollabAgentResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const source = entry as Record<string, unknown>;
    const threadId = toText(source.threadId);
    const status = toText(source.status);
    if (!threadId || !status) return [];
    const message = toText(source.message);
    return [{ threadId, status, ...(message ? { message } : {}) }];
  });
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function getCollabAgentStepInfo(details: Record<string, unknown>): CollabAgentStepInfo {
  const prompt = toText(details.prompt);
  const tool = toText(details.tool);
  const taskName = toText(details.name || details.agentName);
  const title = taskName || prompt || TOOL_LABELS[tool] || '协作代理';
  const fullTitle = prompt || title;
  const results = readAgentResults(details.agentResults);
  const statusSummary = STATUS_LABELS.flatMap(([status, label]) => {
    const count = results.filter((result) => result.status === status).length;
    return count > 0 ? [`${count} ${label}`] : [];
  });
  const messages = results.flatMap((result, index) => result.message
    ? [{ index: index + 1, message: result.message }]
    : []);

  return {
    action: isCollabAgentSubtask(details) ? '子任务' : '协作操作',
    title: truncate(title, 180),
    fullTitle,
    ...(results.length > 0
      ? { metadata: [`${results.length} 个子任务${statusSummary.length ? ` · ${statusSummary.join(' · ')}` : ''}`] }
      : {}),
    ...(messages.length === 1
      ? { output: messages[0].message }
      : messages.length > 1
        ? { output: messages.map(({ index, message }) => `子任务 ${index}\n${message}`).join('\n\n') }
        : {}),
  };
}
