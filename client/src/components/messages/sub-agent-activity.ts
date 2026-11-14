export interface SubAgentActivityStepInfo {
  action: string;
  title: string;
  fullTitle: string;
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readTaskNameFromAgentPath(value: unknown): string {
  const path = toText(value).replace(/\\/g, '/').replace(/\/+$/, '');
  if (!path) return '';
  return path.slice(path.lastIndexOf('/') + 1).trim();
}

export function getSubAgentActivityStepInfo(
  details: Record<string, unknown>,
): SubAgentActivityStepInfo {
  const taskName = toText(details.name || details.agentName)
    || readTaskNameFromAgentPath(details.agentPath);
  const title = taskName
    || toText(details.content || details.text)
    || '子代理活动';

  return {
    action: '子任务',
    title,
    fullTitle: title,
  };
}
