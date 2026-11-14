import { ZcodeProcessExitError, ZcodeProtocolParseError } from './transport.js';
import { sanitizeEngineErrorMessage, sanitizeTechnicalSummary, type EngineDiagnostic, type EngineDiagnosticContext } from '../engine/diagnostics.js';

export type ZcodeErrorCode =
  | 'ZCODE_NOT_INSTALLED'
  | 'ZCODE_PROVIDER_ERROR'
  | 'ZCODE_PROCESS_START_FAILED'
  | 'ZCODE_PROCESS_EXITED'
  | 'ZCODE_PROTOCOL_ERROR'
  | 'ZCODE_PROMPT_STALLED'
  | 'ZCODE_FINAL_ANSWER_MISSING'
  | 'ZCODE_TURN_CANCELLED';

export class ZcodePromptStalledError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`ZCode prompt 在 ${timeoutMs}ms 内没有协议活动`);
    this.name = 'ZcodePromptStalledError';
  }
}

export function mapZcodeError(
  error: unknown,
  context: EngineDiagnosticContext = { phase: 'provider' },
): EngineDiagnostic {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const technicalSummary = sanitizeTechnicalSummary(error);
  const originalMessage = sanitizeEngineErrorMessage(message);
  const diagnostic = (code: ZcodeErrorCode | undefined, userMessage: string, input: Partial<EngineDiagnostic> = {}): EngineDiagnostic => ({
    ...(code ? { code } : {}),
    phase: context.phase,
    retryable: false,
    userMessage,
    ...(originalMessage ? { originalMessage } : {}),
    ...(technicalSummary ? { technicalSummary } : {}),
    ...input,
  });
  if (error instanceof ZcodePromptStalledError) {
    return diagnostic('ZCODE_PROMPT_STALLED', 'ZCode 长时间没有响应，已回收连接', { retryable: true });
  }
  if (message === 'ZCODE_NOT_INSTALLED' || /ZCODE_NOT_INSTALLED|未找到 ZCode 可执行/.test(message)) {
    return diagnostic('ZCODE_NOT_INSTALLED', '未检测到 ZCode 桌面应用，请先安装并登录 ZCode', { phase: 'connect', providerClass: 'auth' });
  }
  if (/Session not found|Session is not active/i.test(message)) {
    return diagnostic('ZCODE_PROVIDER_ERROR', 'ZCode 会话不存在或已失效，请新建会话', { retryable: false });
  }
  if (/auth(?:entication)? required|not logged in|login required|登出|请.*登录/i.test(message)) {
    return diagnostic('ZCODE_PROVIDER_ERROR', 'ZCode 尚未登录，请先在 ZCode 客户端完成登录', { providerClass: 'auth' });
  }
  if (/spawn|ENOENT|启动失败/i.test(message)) {
    return diagnostic('ZCODE_PROCESS_START_FAILED', 'ZCode app-server 启动失败', { phase: 'connect', retryable: true });
  }
  if (error instanceof ZcodeProcessExitError) {
    return diagnostic('ZCODE_PROCESS_EXITED', 'ZCode app-server 已退出', { phase: 'close', retryable: true });
  }
  if (error instanceof ZcodeProtocolParseError) {
    return diagnostic('ZCODE_PROTOCOL_ERROR', 'ZCode 协议通信失败', { phase: 'protocol', retryable: true });
  }
  if (/cancelled|canceled|abort/i.test(message)) {
    return diagnostic('ZCODE_TURN_CANCELLED', 'ZCode 回合已取消', { phase: 'cancel' });
  }
  return diagnostic(undefined, 'ZCode 服务执行失败', { providerClass: 'unknown', retryable: true });
}
