import type { PendingApprovalKind } from '../../generated/relay-contracts.ts';
import { containsInteractionCommandSyntax, normalizeInteractionReason } from '../../../../server/src/engine/interaction-purpose.ts';

type ApprovalPresentationInput = {
  kind: PendingApprovalKind;
  fallbackTitle?: string;
  details: Record<string, unknown>;
};

const CHINESE_TEXT_PATTERN = /[\u3400-\u9fff]/;

const FALLBACK_PURPOSES = {
  command_approval: '需要授权执行命令',
  file_approval: '需要授权修改文件',
  permissions_approval: '需要授予额外权限',
  mcp_elicitation: '工具需要补充信息',
};

function normalizeWhitespace(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1');
}

function normalizeChineseTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeWhitespace(value);
  return normalized && CHINESE_TEXT_PATTERN.test(normalized) ? normalized : null;
}

function inlineParameterPlaceholder(kind: PendingApprovalKind, networkApproval: boolean): string {
  if (kind === 'command_approval') return '相关命令';
  if (kind === 'file_approval') return '相关文件';
  if (kind === 'mcp_elicitation') return '相关信息';
  return networkApproval ? '相关地址' : '相关权限参数';
}

function normalizeChineseReason(
  value: unknown,
  kind: PendingApprovalKind,
  networkApproval: boolean,
): string | null {
  if (typeof value !== 'string') return null;
  const purpose = normalizeInteractionReason(value, inlineParameterPlaceholder(kind, networkApproval));
  return purpose && CHINESE_TEXT_PATTERN.test(purpose) && !containsInteractionCommandSyntax(purpose)
    ? purpose
    : null;
}

function hasNetworkScope(details: Record<string, unknown>): boolean {
  return details.networkApprovalContext != null
    || details.proposedNetworkPolicyAmendments != null;
}

export function getApprovalPresentation(input: ApprovalPresentationInput): {
  typeLabel: string;
  purpose: string;
} {
  if (input.kind === 'user_input' || input.kind === 'async_question') {
    return { typeLabel: '提问', purpose: input.fallbackTitle || '需要回答' };
  }
  if (input.kind === 'mcp_elicitation') {
    return {
      typeLabel: 'MCP',
      purpose: normalizeChineseTitle(input.details.message)
        || normalizeChineseTitle(input.fallbackTitle)
        || FALLBACK_PURPOSES.mcp_elicitation,
    };
  }
  const networkApproval = input.kind === 'permissions_approval' && hasNetworkScope(input.details);
  const typeLabel = input.kind === 'command_approval'
    ? '命令'
    : input.kind === 'file_approval'
      ? '文件'
      : networkApproval
        ? '网络'
        : '权限';
  const fallbackPurpose = networkApproval
    ? '需要授权访问网络'
    : normalizeChineseTitle(input.fallbackTitle) || FALLBACK_PURPOSES[input.kind];

  return {
    typeLabel,
    purpose: normalizeChineseReason(input.details.reason, input.kind, networkApproval) || fallbackPurpose,
  };
}
