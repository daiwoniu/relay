import {
  JsonRpcConnectionClosedError,
  JsonRpcRemoteError,
  JsonRpcTimeoutError,
} from '../engine/json-rpc/core.js';
import {
  AcpProcessExitError,
  AcpProcessStartupTimeoutError,
  StdioAcpTransportParseError,
} from '../engine/transports/stdio-acp.js';
import { sanitizeTechnicalSummary, type EngineDiagnostic, type EngineDiagnosticContext } from '../engine/diagnostics.js';

export type CodeBuddyErrorCode =
  | 'CODEBUDDY_AUTH_REQUIRED'
  | 'CODEBUDDY_PROVIDER_ERROR'
  | 'CODEBUDDY_PROCESS_START_FAILED'
  | 'CODEBUDDY_PROCESS_EXITED'
  | 'CODEBUDDY_PROTOCOL_ERROR'
  | 'CODEBUDDY_PROMPT_STALLED'
  | 'CODEBUDDY_FINAL_ANSWER_MISSING'
  | 'CODEBUDDY_TURN_CANCELLED';

export class CodeBuddyPromptStalledError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`CodeBuddy prompt 在 ${timeoutMs}ms 内没有协议活动`);
    this.name = 'CodeBuddyPromptStalledError';
  }
}

export function classifyCodeBuddyCapacityMetadata(meta: unknown): Pick<EngineDiagnostic, 'providerClass' | 'retryAfterMs'> | null {
  if (!meta || typeof meta !== 'object') return null;
  const record = meta as Record<string, unknown>;
  const rawCode = record['codebuddy.ai/errorCode'] ?? record['codebuddy.ai/outcome'] ?? record['codebuddy.ai/finishReason'];
  if (typeof rawCode !== 'string') return null;
  const code = rawCode.trim().toUpperCase().replace(/[\s-]+/g, '_');
  const providerClass = ['RATE_LIMIT', 'RATE_LIMITED', 'TOO_MANY_REQUESTS'].includes(code)
    ? 'rate_limit' as const
    : ['OVERLOADED', 'SERVER_OVERLOADED', 'PROVIDER_OVERLOADED'].includes(code)
      ? 'overloaded' as const
      : null;
  if (!providerClass) return null;
  const rawRetryAfterMs = record['codebuddy.ai/retryAfterMs'];
  const retryAfterMs = typeof rawRetryAfterMs === 'number' && Number.isFinite(rawRetryAfterMs) && rawRetryAfterMs >= 0
    ? Math.min(Math.trunc(rawRetryAfterMs), 3_600_000)
    : undefined;
  return { providerClass, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

export function mapCodeBuddyError(
  error: unknown,
  context: EngineDiagnosticContext = { phase: 'provider' },
): EngineDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const technicalSummary = sanitizeTechnicalSummary(error);
  const diagnostic = (code: CodeBuddyErrorCode | undefined, userMessage: string, input: Partial<EngineDiagnostic> = {}): EngineDiagnostic => ({
    ...(code ? { code } : {}),
    phase: context.phase,
    retryable: false,
    userMessage,
    ...(technicalSummary ? { technicalSummary } : {}),
    ...input,
  });
  if (error instanceof CodeBuddyPromptStalledError) {
    return diagnostic('CODEBUDDY_PROMPT_STALLED', 'CodeBuddy 长时间没有响应，已回收连接', { retryable: true });
  }
  if (/auth(?:entication)? required|not logged in|login required|请.*登录/i.test(message)) {
    return diagnostic('CODEBUDDY_AUTH_REQUIRED', 'CodeBuddy 尚未登录，请先在终端完成登录', { providerClass: 'auth' });
  }
  if (error instanceof AcpProcessStartupTimeoutError || /CLI_NOT_INSTALLED|spawn/i.test(message)) {
    return diagnostic('CODEBUDDY_PROCESS_START_FAILED', 'CodeBuddy 子进程启动失败', { phase: 'connect', retryable: true });
  }
  if (error instanceof AcpProcessExitError || error instanceof JsonRpcConnectionClosedError) {
    return diagnostic('CODEBUDDY_PROCESS_EXITED', 'CodeBuddy 子进程已退出', { phase: 'close', retryable: true });
  }
  if (error instanceof StdioAcpTransportParseError || error instanceof JsonRpcTimeoutError) {
    return diagnostic('CODEBUDDY_PROTOCOL_ERROR', 'CodeBuddy ACP 协议通信失败', { phase: 'protocol', retryable: true });
  }
  if (error instanceof JsonRpcRemoteError && error.rpcCode === -32601) {
    return diagnostic('CODEBUDDY_PROTOCOL_ERROR', 'CodeBuddy 不支持当前 ACP 方法', { phase: 'protocol' });
  }
  if (/cancelled|canceled|abort/i.test(message)) {
    return diagnostic('CODEBUDDY_TURN_CANCELLED', 'CodeBuddy 回合已取消', { phase: 'cancel' });
  }
  return diagnostic(undefined, 'CodeBuddy 服务执行失败', { providerClass: 'unknown', retryable: true });
}
