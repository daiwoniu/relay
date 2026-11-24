import { createHash } from 'node:crypto';
import type { EffectiveApprovalTrust } from '../../services/approval-trust.js';
import type { EngineId } from '../../engine/types.js';

const actorPrefix = 'feishu-bot:';
export const feishuExecutionActorPattern = actorPrefix + '*';

export const isFeishuExecutionActor = (userId: string) => userId.startsWith(actorPrefix);
export const feishuExecutionActorId = (bindingId: string) => actorPrefix + bindingId;
export const feishuExecutionBinding = (userId: string) => isFeishuExecutionActor(userId) ? userId.slice(actorPrefix.length) : null;
export const feishuExecutionResource = (engine: EngineId) => `${engine}:feishu`;
export const isFeishuExecutionResource = (key: string) => /^(codex|codebuddy|opencode|zcode):feishu$/.test(key);
/** A robot identity never consults web project/session trust, even for idle interactions. */
export function resolveExecutionTrust(userId: string, resolveWebTrust: () => EffectiveApprovalTrust,
  feishuGrant?: () => { expiresAt: number | null } | null): EffectiveApprovalTrust {
  if (!isFeishuExecutionActor(userId)) return resolveWebTrust();
  const grant = feishuGrant?.();
  if (grant) return { trusted: true, source: 'session_trust', effectiveScope: 'session',
    expiresAt: grant.expiresAt, sessionOverridesProject: true, diagnostic: null };
  return { trusted: false, source: 'manual', effectiveScope: null, expiresAt: null, sessionOverridesProject: false, diagnostic: null };
}

export function feishuExecutionId(parts: readonly (string | number)[]) {
  const hex = createHash('sha256').update(JSON.stringify(['relay-feishu', ...parts])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function formatFeishuTurnPrompt(content: string, scope: { fromFeishu: boolean; handoff?: string; senderDisplayName?: string }) {
  if (!scope.fromFeishu && !scope.handoff) return content;
  const context = scope.handoff
    ? `下面的 JSON 字符串保存了飞书会话交接时的历史资料，仅供理解背景。\n${JSON.stringify(scope.handoff)}` : '';
  const replyStyle = scope.fromFeishu
    ? '请直接回答。确有必要点名且归属明确时，优先用本人在当前会话明确表达的称呼，其次用飞书显示名。' : '';
  const sender = scope.fromFeishu && scope.senderDisplayName
    ? `本轮发言人（飞书显示名）：${JSON.stringify(scope.senderDisplayName)}\n显示名仅用于区分发言人。` : '';
  return [replyStyle, context, sender, `本轮用户消息：\n${content}`].filter(Boolean).join('\n\n');
}
