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
import { sanitizeEngineErrorMessage, sanitizeTechnicalSummary, type EngineDiagnostic, type EngineDiagnosticContext } from '../engine/diagnostics.js';

export type OpenCodeErrorCode =
  | 'OPENCODE_AUTH_REQUIRED'
  | 'OPENCODE_PROVIDER_ERROR'
  | 'OPENCODE_PROCESS_START_FAILED'
  | 'OPENCODE_PROCESS_EXITED'
  | 'OPENCODE_PROTOCOL_ERROR'
  | 'OPENCODE_PROMPT_STALLED'
  | 'OPENCODE_FINAL_ANSWER_MISSING'
  | 'OPENCODE_TURN_CANCELLED';

export class OpenCodePromptStalledError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`OpenCode prompt 在 ${timeoutMs}ms 内没有协议活动`);
    this.name = 'OpenCodePromptStalledError';
  }
}

export function classifyOpenCodeCapacityMetadata(meta: unknown): Pick<EngineDiagnostic, 'providerClass' | 'retryAfterMs'> | null {
  if (!meta || typeof meta !== 'object') return null;
  const record = meta as Record<string, unknown>;
  const rawCode = record.errorCode ?? record.outcome ?? record.finishReason;
  if (typeof rawCode !== 'string') return null;
  const code = rawCode.trim().toUpperCase().replace(/[\s-]+/g, '_');
  const providerClass = ['RATE_LIMIT', 'RATE_LIMITED', 'TOO_MANY_REQUESTS'].includes(code)
    ? 'rate_limit' as const
    : ['OVERLOADED', 'SERVER_OVERLOADED', 'PROVIDER_OVERLOADED'].includes(code)
      ? 'overloaded' as const
      : null;
  if (!providerClass) return null;
  const rawRetryAfterMs = record.retryAfterMs;
  const retryAfterMs = typeof rawRetryAfterMs === 'number' && Number.isFinite(rawRetryAfterMs) && rawRetryAfterMs >= 0
    ? Math.min(Math.trunc(rawRetryAfterMs), 3_600_000)
    : undefined;
  return { providerClass, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

export function mapOpenCodeError(
  error: unknown,
  context: EngineDiagnosticContext = { phase: 'provider' },
): EngineDiagnostic {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const technicalSummary = sanitizeTechnicalSummary(error);
  // Preserve the complete provider text for the authenticated message UI while
  // keeping the shorter technical summary available for bounded diagnostics.
  const originalMessage = sanitizeEngineErrorMessage(message);
  const diagnostic = (code: OpenCodeErrorCode | undefined, userMessage: string, input: Partial<EngineDiagnostic> = {}): EngineDiagnostic => ({
    ...(code ? { code } : {}),
    phase: context.phase,
    retryable: false,
    userMessage,
    ...(originalMessage ? { originalMessage } : {}),
    ...(technicalSummary ? { technicalSummary } : {}),
    ...input,
  });
  if (error instanceof OpenCodePromptStalledError) {
    return diagnostic('OPENCODE_PROMPT_STALLED', 'OpenCode 长时间没有响应，已回收连接', { retryable: true });
  }
  if (/auth(?:entication)? required|not logged in|login required|请.*登录/i.test(message)) {
    return diagnostic('OPENCODE_AUTH_REQUIRED', 'OpenCode 尚未登录，请先在终端完成登录', { providerClass: 'auth' });
  }
  if (error instanceof AcpProcessStartupTimeoutError || /CLI_NOT_INSTALLED|spawn/i.test(message)) {
    return diagnostic('OPENCODE_PROCESS_START_FAILED', 'OpenCode 子进程启动失败', { phase: 'connect', retryable: true });
  }
  if (error instanceof AcpProcessExitError || error instanceof JsonRpcConnectionClosedError) {
    return diagnostic('OPENCODE_PROCESS_EXITED', 'OpenCode 子进程已退出', { phase: 'close', retryable: true });
  }
  if (error instanceof StdioAcpTransportParseError || error instanceof JsonRpcTimeoutError) {
    return diagnostic('OPENCODE_PROTOCOL_ERROR', 'OpenCode ACP 协议通信失败', { phase: 'protocol', retryable: true });
  }
  if (error instanceof JsonRpcRemoteError && error.rpcCode === -32601) {
    return diagnostic('OPENCODE_PROTOCOL_ERROR', 'OpenCode 不支持当前 ACP 方法', { phase: 'protocol' });
  }
  if (/cancelled|canceled|abort/i.test(message)) {
    return diagnostic('OPENCODE_TURN_CANCELLED', 'OpenCode 回合已取消', { phase: 'cancel' });
  }
  return diagnostic(undefined, 'OpenCode 服务执行失败', { providerClass: 'unknown', retryable: true });
}