import type { RelayWSMessage } from './protocol.js';

export function extractPlanUpdate(params: any, currentTurnId: string | null, threadId: string | null): RelayWSMessage | null {
  const turnId = params.turnId;
  if (!currentTurnId || turnId !== currentTurnId || !Array.isArray(params.plan)) return null;
  const explanation = typeof params.explanation === 'string' ? params.explanation.trim() : '';
  // The item represents a received snapshot; each plan step retains its own status.
  return {
    type: 'item_complete',
    threadId: threadId || undefined,
    turnId,
    item: {
      id: `relay-plan:${turnId}`,
      type: 'plan',
      status: 'completed',
      plan: params.plan,
      // Keep an explicit empty value so a later snapshot can clear an earlier explanation.
      explanation,
    },
  };
}

export function presentWarningNotification(method: string, params: any): RelayWSMessage {
  if (method === 'warning' || method === 'guardianWarning') {
    return {
      type: 'system_notice',
      noticeType: method === 'guardianWarning' ? 'guardian_warning' : 'warning',
      title: method === 'guardianWarning' ? '安全警告' : '运行提示',
      message: typeof params.message === 'string' ? params.message : undefined,
    };
  }
  return {
    type: 'system_notice',
    noticeType: method === 'configWarning' ? 'config_warning' : 'deprecation',
    title: typeof params.summary === 'string' ? params.summary : '配置提示',
    message: typeof params.details === 'string' ? params.details : undefined,
    details: { path: params.path, range: params.range },
  };
}

export function presentModelReroutedNotice(params: any): RelayWSMessage {
  return {
    type: 'system_notice',
    noticeType: 'model_rerouted',
    title: '模型已切换',
    message: `${params.fromModel || '原模型'} → ${params.toModel || '新模型'}`,
    details: { reason: params.reason, fromModel: params.fromModel, toModel: params.toModel },
  };
}

export function extractThreadTokenUsage(params: any): Extract<RelayWSMessage, { type: 'token_usage' }>['usage'] | null {
  const tokenUsage = params?.tokenUsage;
  const last = tokenUsage?.last;
  const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'] as const;
  if (!last || fields.some((field) => typeof last[field] !== 'number' || !Number.isFinite(last[field]) || last[field] < 0)) {
    return null;
  }
  return {
    inputTokens: last.inputTokens,
    cachedInputTokens: last.cachedInputTokens,
    outputTokens: last.outputTokens,
    reasoningOutputTokens: last.reasoningOutputTokens,
    totalTokens: last.totalTokens,
    modelContextWindow: typeof tokenUsage.modelContextWindow === 'number' && tokenUsage.modelContextWindow > 0
      ? tokenUsage.modelContextWindow
      : null,
  };
}

export function extractTurnId(value: any): string | null {
  const candidates = [value?.turn?.id, value?.turnId, value?.turn_id];
  return candidates.find((candidate) => typeof candidate === 'string' && candidate) || null;
}

function toCodexErrorCode(value: unknown): string {
  const variant = typeof value === 'string'
    ? value
    : value && typeof value === 'object'
      ? Object.keys(value)[0]
      : '';
  const normalized = variant
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return normalized ? `CODEX_${normalized}` : 'CODEX_TURN_FAILED';
}

export function extractTurnFailure(value: any): { message: string; code: string } | null {
  const turn = value?.turn;
  if (!turn || typeof turn !== 'object') return null;

  const status = typeof turn.status === 'string' ? turn.status : '';
  if (status === 'interrupted') {
    return {
      message: typeof turn.error?.message === 'string' && turn.error.message.trim()
        ? turn.error.message.trim()
        : 'Codex 回合已中断',
      code: 'CODEX_TURN_INTERRUPTED',
    };
  }
  if (status !== 'failed') return null;

  const messageCandidates = [turn.error?.message, turn.error?.additionalDetails, turn.error?.additional_details];
  const message = messageCandidates.find((candidate) => typeof candidate === 'string' && candidate.trim())?.trim()
    || 'Codex 回合执行失败';
  return {
    message,
    code: toCodexErrorCode(turn.error?.codexErrorInfo ?? turn.error?.codex_error_info),
  };
}
