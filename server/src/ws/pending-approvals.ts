import {
  PendingApprovalDtoSchema,
  type ApprovalAction,
  type PendingApprovalDto,
  type PendingApprovalKind,
} from '../contracts/index.js';
import type { EngineId } from '../engine/types.js';

export type RuntimeInteractionItem = {
  id: string;
  type: string;
  status: string;
  details?: Record<string, unknown>;
};

export type PendingApprovalRuntimeSource = {
  sessionId: string;
  sessionTitle: string;
  engine: EngineId;
  items: RuntimeInteractionItem[];
  pending: Array<{ interactionId: string; createdAt: number }>;
};

const DEFAULT_ACTIONS: ApprovalAction[] = ['accept', 'accept_for_session', 'decline', 'cancel'];
const DECISION_ACTIONS: Record<string, ApprovalAction> = {
  accept: 'accept',
  acceptForSession: 'accept_for_session',
  decline: 'decline',
  cancel: 'cancel',
};

function truncate(value: string, maxLength = 180): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function normalizeActions(value: unknown): ApprovalAction[] {
  if (!Array.isArray(value)) return [...DEFAULT_ACTIONS];
  const result: ApprovalAction[] = [];
  for (const decision of value) {
    if (typeof decision !== 'string') continue;
    const action = DECISION_ACTIONS[decision];
    if (action && !result.includes(action)) result.push(action);
  }
  return result;
}

function getKind(value: unknown): PendingApprovalKind | null {
  return value === 'command_approval' || value === 'file_approval' || value === 'permissions_approval' || value === 'mcp_elicitation' || value === 'user_input' || value === 'async_question'
    ? value
    : null;
}

function fileSummary(details: Record<string, unknown>): string {
  const fileChanges = details.fileChanges;
  if (fileChanges && typeof fileChanges === 'object' && !Array.isArray(fileChanges)) {
    const files = Object.keys(fileChanges);
    if (files.length > 0) return files.length === 1
      ? `请求修改文件：${files[0]}`
      : `请求修改文件：${files[0]}，另有 ${files.length - 1} 个文件`;
  }
  if (typeof details.grantRoot === 'string' && details.grantRoot.trim()) return `请求访问目录：${details.grantRoot.trim()}`;
  const rawInput = details.rawInput && typeof details.rawInput === 'object'
    ? details.rawInput as Record<string, unknown>
    : {};
  const target = typeof rawInput.filePath === 'string' ? rawInput.filePath : rawInput.path;
  if (typeof target === 'string' && target.trim()) return truncate(`请求修改文件：${target.trim()}`);
  return '请求修改文件';
}

function approvalSummary(kind: PendingApprovalKind, details: Record<string, unknown>): string {
  if (kind === 'user_input' || kind === 'async_question') {
    const first = Array.isArray(details.questions) ? details.questions[0] : null;
    const question = first && typeof first === 'object' ? first as Record<string, unknown> : {};
    const text = question.question || question.title || question.header || details.title;
    return truncate(typeof text === 'string' && text.trim() ? text : '助手需要你回答问题');
  }
  if (kind === 'mcp_elicitation') {
    if (typeof details.message === 'string' && details.message.trim()) return truncate(`工具需要补充信息：${details.message}`);
    return '工具需要补充信息';
  }
  if (kind === 'command_approval') {
    if (typeof details.command === 'string' && details.command.trim()) return truncate(`请求运行命令：${details.command}`);
    const firstAction = Array.isArray(details.commandActions) ? details.commandActions[0] : null;
    if (firstAction && typeof firstAction === 'object' && typeof (firstAction as Record<string, unknown>).command === 'string') {
      return truncate(`请求运行命令：${String((firstAction as Record<string, unknown>).command)}`);
    }
    if (typeof details.reason === 'string' && details.reason.trim()) return truncate(`请求运行命令：${details.reason}`);
    return '请求运行命令';
  }
  if (kind === 'file_approval') return truncate(fileSummary(details));
  const networkRequest = details.networkApprovalContext || details.proposedNetworkPolicyAmendments;
  if (networkRequest) {
    if (typeof details.reason === 'string' && details.reason.trim()) return truncate(`请求访问网络：${details.reason}`);
    return '请求访问网络';
  }
  if (typeof details.reason === 'string' && details.reason.trim()) return truncate(`请求额外权限：${details.reason}`);
  return '请求额外权限';
}

export function presentPendingApproval(input: {
  sessionId: string;
  sessionTitle: string;
  engine: EngineId;
  item: RuntimeInteractionItem;
  createdAt: number;
}): PendingApprovalDto | null {
  if (input.item.type !== 'interaction') return null;
  const details = input.item.details || {};
  const kind = getKind(details.interactionKind);
  if (!kind) return null;
  return PendingApprovalDtoSchema.parse({
    id: input.item.id,
    sessionId: input.sessionId,
    sessionTitle: input.sessionTitle.trim() || '未命名会话',
    engine: input.engine,
    kind,
    title: kind === 'user_input' || kind === 'async_question' ? approvalSummary(kind, details) : typeof details.title === 'string' && details.title.trim() ? details.title.trim() : '需要授权',
    summary: approvalSummary(kind, details),
    details,
    availableActions: kind === 'mcp_elicitation' || kind === 'user_input' || kind === 'async_question' ? [] : normalizeActions(details.availableDecisions),
    createdAt: input.createdAt,
  });
}

export function collectPendingApprovals(sources: PendingApprovalRuntimeSource[]): PendingApprovalDto[] {
  const approvals = sources.flatMap((source) => source.pending.flatMap((pending) => {
    const item = source.items.find((candidate) => candidate.id === pending.interactionId);
    if (!item) return [];
    const approval = presentPendingApproval({
      sessionId: source.sessionId,
      sessionTitle: source.sessionTitle,
      engine: source.engine,
      item,
      createdAt: pending.createdAt,
    });
    return approval ? [approval] : [];
  }));
  return approvals.sort((left, right) => (
    left.createdAt - right.createdAt
    || left.sessionId.localeCompare(right.sessionId)
    || left.id.localeCompare(right.id)
  ));
}
