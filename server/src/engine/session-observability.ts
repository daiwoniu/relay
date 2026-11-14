import type { EngineId } from './types.js';

export const SESSION_TERMINAL_LOG_PREFIX = '[Relay:SessionTerminal] ';

export type SessionTerminalLogInput = {
  sessionId: string;
  engine: EngineId;
  model?: string | null;
  outcome: 'failed' | 'interrupted' | 'stopped';
  code?: string;
  phase?: string;
  providerClass?: string;
  retryable?: boolean;
  durationMs?: number | null;
  message?: string;
};

export function formatSessionTerminalLog(input: SessionTerminalLogInput): string {
  const payload = {
    sessionId: input.sessionId,
    engine: input.engine,
    ...(input.model ? { model: input.model } : {}),
    outcome: input.outcome,
    ...(input.code ? { code: input.code } : {}),
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.providerClass ? { providerClass: input.providerClass } : {}),
    ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
    ...(typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) ? { durationMs: Math.max(0, Math.trunc(input.durationMs)) } : {}),
    ...(input.message ? { message: input.message.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').slice(0, 500) } : {}),
  };
  return `${SESSION_TERMINAL_LOG_PREFIX}${JSON.stringify(payload)}`;
}

export function writeSessionTerminalLog(input: SessionTerminalLogInput, write: (line: string) => void = console.warn): void {
  try { write(formatSessionTerminalLog(input)); } catch {
    // 诊断日志不能影响会话终态收口。
  }
}
