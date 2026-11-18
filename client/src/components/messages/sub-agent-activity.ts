export interface SubAgentActivityStepInfo {
  action: string;
  title: string;
  fullTitle: string;
  output?: string;
  metadata?: string[];
  expandable: boolean;
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readTaskNameFromAgentPath(value: unknown): string {
  const path = toText(value).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!path) return '';
  return path.slice(path.lastIndexOf('/') + 1).trim();
}

export function getSubAgentActivityLabel(details: Record<string, unknown>): string {
  return ({ started: '已启动', interacted: '发生交互', completed: '执行结束' } as Record<string, string>)[toText(details.kind)] || '活动通知';
}

export function hasSubAgentReportReference(step: { id: string; type: string; status: string; details: Record<string, unknown> }): boolean {
  return step.type === 'subAgentActivity' && step.status === 'completed' && step.details.kind === 'completed'
    && step.id.startsWith('subagent-completed-') && Boolean(toText(step.details.agentThreadId));
}

export function getSubAgentActivityStepInfo(
  details: Record<string, unknown>,
): SubAgentActivityStepInfo {
  const taskName = toText(details.name || details.agentName)
    || readTaskNameFromAgentPath(details.agentPath);
  const name = taskName
    || toText(details.content || details.text)
    || '子代理活动';
  const title = name;
  const output = toText(details.content) || toText(details.text) || toText(details.message);
  const metadata = [toText(details.model), toText(details.reasoningEffort)].filter(Boolean);

  return {
    action: '子任务',
    title,
    fullTitle: title,
    ...(output ? { output } : {}),
    ...(metadata.length ? { metadata } : {}),
    expandable: Boolean(output || metadata.length),
  };
}
