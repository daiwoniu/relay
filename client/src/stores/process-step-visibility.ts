import type { ProcessStep, ProcessTimelineEntry } from './chat';

const VISIBLE_TYPES = new Set([
  'commandExecution', 'webSearch', 'fileChange', 'reasoning',
  'mcpToolCall', 'dynamicToolCall', 'plan', 'collabAgentToolCall',
  'subAgentActivity', 'imageGeneration',
  'interaction', 'systemNotice', 'contextCompaction',
  'imageView', 'hookPrompt', 'sleep', 'enteredReviewMode', 'exitedReviewMode',
]);

type StepDetails = Record<string, any>;

function reasoningFieldText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  return value.map((entry) => {
    if (typeof entry === 'string') return entry;
    return entry && typeof entry === 'object' && typeof entry.text === 'string' ? entry.text : '';
  }).join('').trim();
}

export function getReasoningDisplayText(details: StepDetails): string {
  return reasoningFieldText(details.content)
    || reasoningFieldText(details.text)
    || reasoningFieldText(details.summary);
}

function toText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getCommand(details: StepDetails): string {
  const actions = Array.isArray(details.commandActions) ? details.commandActions : [];
  const actualCommand = actions.find((action: any) => toText(action?.command))?.command;
  return toText(actualCommand || details.command || details.content || details.text);
}

export { toText as getProcessText, getCommand as getProcessCommand };

function hasChangedFile(details: StepDetails): boolean {
  if (toText(details.path || details.filePath || details.file)) return true;
  const changes = details.changes || details.files || details.fileChanges;
  return Array.isArray(changes) && changes.some((change) => (
    typeof change === 'string'
      ? Boolean(change.trim())
      : Boolean(toText(change?.path || change?.filePath || change?.file))
  ));
}

export function hasVisibleProcessStep(step: ProcessStep): boolean {
  if (!VISIBLE_TYPES.has(step.type)) return false;
  const data = step.details as StepDetails;
  switch (step.type) {
    case 'commandExecution':
      return Boolean(getCommand(data));
    case 'webSearch':
      return Boolean(toText(data.query || data.searchQuery || data.content || data.url) || (typeof data.action === 'string' ? data.action.trim() : typeof data.action?.type === 'string' && data.action.type.trim()));
    case 'fileChange':
      return hasChangedFile(data) || Boolean(toText(data.diff || data.patch || data.summary));
    case 'reasoning': {
      // Codex 有时只返回 reasoning 的完成事实，不返回可展示摘要；空壳事件保留在数据中，
      // 但不作为有信息量的过程步骤展示。
      return Boolean(getReasoningDisplayText(data));
    }
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return Boolean(toText(data.name || data.toolName || data.tool || data.title));
    case 'collabAgentToolCall':
      return Boolean(toText(data.name || data.agentName || data.prompt || data.tool))
        || (Array.isArray(data.agentResults) && data.agentResults.length > 0);
    case 'imageGeneration':
      return Boolean(toText(data.prompt || data.content));
    case 'plan':
      return Array.isArray(data.plan) || Number(data.planCount) > 0 || Boolean(toText(data.content || data.text));
    case 'subAgentActivity':
      return Boolean(toText(data.name || data.agentName || data.agentPath || data.content || data.text || step.status));
    case 'interaction':
      return Boolean(toText(data.title || data.method)) || (Array.isArray(data.questions) && data.questions.length > 0);
    case 'systemNotice':
      return Boolean(toText(data.title || data.message));
    case 'contextCompaction':
    case 'imageView':
    case 'hookPrompt':
    case 'sleep':
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return true;
    default:
      return false;
  }
}

export function hasVisibleProcessPresentation(
  processContent?: string,
  steps: ProcessStep[] = [],
  timeline: ProcessTimelineEntry[] = [],
): boolean {
  return Boolean(processContent?.trim()) || steps.some(hasVisibleProcessStep)
    || timeline.some(entry => entry.type === 'narrative' && Boolean(entry.content?.trim()));
}
