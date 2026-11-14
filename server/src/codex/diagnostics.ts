import { sanitizeEngineErrorMessage, sanitizeTechnicalSummary, type EngineDiagnostic, type EngineDiagnosticContext } from '../engine/diagnostics.js';

type CodexErrorLike = {
  code?: unknown;
  message?: unknown;
  retryAfterMs?: unknown;
};

function fallbackCode(phase: EngineDiagnosticContext['phase']): string | undefined {
  if (phase === 'connect' || phase === 'availability') return 'CODEX_CONNECT_FAILED';
  if (phase === 'protocol') return 'CODEX_PROTOCOL_ERROR';
  if (phase === 'recovery') return 'RESTART_RECOVERY_FAILED';
  if (phase === 'close') return 'CODEX_CONNECTION_CLOSED';
  return undefined;
}

const USER_MESSAGES: Record<string, string> = {
  CODEX_THREAD_ARCHIVED: '该会话已在 ChatGPT/Codex 中归档，请在会话菜单中选择“取消归档”后重试。',
  CODEX_CONNECTION_TIMEOUT: '连接 Codex app-server 超时',
  CODEX_INIT_FAILED: 'Codex 初始化失败',
  CODEX_CONNECTION_ERROR: 'Codex 连接异常，请检查 app-server 是否已启动',
  CODEX_NOT_CONNECTED: 'Codex 连接已断开',
  CODEX_TURN_ERROR: '发送消息失败',
  CODEX_TURN_INTERRUPTED: 'Codex 回合已中断',
  CODEX_SERVER_OVERLOADED: 'Codex 服务暂时过载',
  CODEX_USAGE_LIMIT_EXCEEDED: 'Codex 使用额度已达到限制',
  CODEX_RESPONSE_STREAM_DISCONNECTED: 'Codex 响应流已断开',
  FINAL_ANSWER_MISSING: '未生成最终回复',
  RESTART_RECOVERY_FAILED: '恢复重启前任务失败',
};

function inferPhase(code: string | undefined, fallback: EngineDiagnosticContext['phase']): EngineDiagnosticContext['phase'] {
  if (code?.startsWith('RESTART_RECOVERY_')) return 'recovery';
  if (code && /STREAM|FINAL_ANSWER_MISSING/.test(code)) return 'stream';
  if (code && /CONNECTION|CONNECT|INIT_FAILED|NOT_CONNECTED/.test(code)) return 'connect';
  if (code && /PROTOCOL/.test(code)) return 'protocol';
  if (code && /INTERRUPTED|CANCEL/.test(code)) return 'cancel';
  return fallback;
}

export function classifyCodexError(error: unknown, context: EngineDiagnosticContext): EngineDiagnostic {
  const record = error && typeof error === 'object' ? error as CodexErrorLike : {};
  const originalCode: string | undefined = typeof record.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(record.code)
    ? record.code
    : fallbackCode(context.phase);
  const phase = inferPhase(originalCode, context.phase);
  const rawMessage = typeof record.message === 'string'
    ? record.message
    : error instanceof Error ? error.message : '';
  const userMessage = originalCode ? (USER_MESSAGES[originalCode] ?? 'Codex 服务执行失败')
    : (phase === 'recovery' ? '恢复重启前任务失败' : 'Codex 服务执行失败');
  const retryAfterMs = typeof record.retryAfterMs === 'number' && Number.isFinite(record.retryAfterMs) && record.retryAfterMs >= 0
    ? Math.min(Math.trunc(record.retryAfterMs), 3_600_000)
    : undefined;
  const codeText = `${originalCode ?? ''} ${rawMessage}`;
  const providerClass = originalCode === 'CODEX_USAGE_LIMIT_EXCEEDED'
    ? 'rate_limit' as const
    : originalCode === 'CODEX_SERVER_OVERLOADED'
      ? 'overloaded' as const
      : /auth|login|unauthorized/i.test(codeText)
    ? 'auth' as const
    : /rate.?limit|429/i.test(codeText)
      ? 'rate_limit' as const
      : /overload/i.test(codeText)
        ? 'overloaded' as const
        : /unavailable|connection/i.test(codeText)
          ? 'unavailable' as const
          : 'unknown' as const;
  // Preserve the complete provider text for the authenticated message UI while
  // keeping the shorter technical summary available for bounded diagnostics.
  const originalMessage = sanitizeEngineErrorMessage(rawMessage);
  const technicalSummary = sanitizeTechnicalSummary(error);
  return {
    ...(originalCode ? { code: originalCode } : {}),
    phase,
    retryable: providerClass === 'rate_limit' || providerClass === 'overloaded' || providerClass === 'unavailable',
    userMessage,
    ...(originalMessage ? { originalMessage } : {}),
    ...(technicalSummary ? { technicalSummary } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    providerClass,
  };
}
