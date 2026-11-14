import { sanitizeLocalErrorMessage } from '../engine/diagnostics.js';

export const TURN_PREPARATION_CODES = ['TURN_START_PREPARATION_FAILED', 'TURN_PREPARATION_ENGINE_UNAVAILABLE',
  'TURN_PREPARATION_CONNECTION_TIMEOUT', 'TURN_PREPARATION_MODEL_UNAVAILABLE', 'TURN_PREPARATION_ATTACHMENT_INVALID',
  'TURN_PREPARATION_STORAGE_UNAVAILABLE', 'TURN_PREPARATION_CONFLICT', 'TURN_PREPARATION_ACCESS_DENIED'] as const;
export type TurnPreparationDiagnostic = { code: typeof TURN_PREPARATION_CODES[number]; message: string };

export function classifyTurnPreparationError(error: unknown): TurnPreparationDiagnostic {
  const record = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
  const raw = typeof record.message === 'string' ? record.message : typeof error === 'string' ? error : '';
  const code = typeof record.code === 'string' ? record.code : '';
  const text = `${code} ${raw}`;
  const reason: TurnPreparationDiagnostic['code'] = /FORBIDDEN|UNAUTHORIZED|AUTH_REQUIRED|ACCESS_DENIED|EACCES|EPERM|未登录|登录.*失效|无权访问/i.test(text) ? 'TURN_PREPARATION_ACCESS_DENIED'
    : /STORAGE_UNAVAILABLE|SQLITE_|数据库/i.test(text) ? 'TURN_PREPARATION_STORAGE_UNAVAILABLE'
    : /CONFLICT|SUPERSEDED|OPERATION_EXPIRED/.test(code) ? 'TURN_PREPARATION_CONFLICT'
    : /ATTACHMENT|附件|不支持.*图片/i.test(text) ? 'TURN_PREPARATION_ATTACHMENT_INVALID'
    : /MODEL.*(?:UNAVAILABLE|NOT_FOUND|INVALID)|模型.*(?:不存在|不可用|不支持)/i.test(text) ? 'TURN_PREPARATION_MODEL_UNAVAILABLE'
    : /TIMEOUT|TIMEDOUT|超时/i.test(text) ? 'TURN_PREPARATION_CONNECTION_TIMEOUT'
    : /ENGINE_UNAVAILABLE|NOT_CONNECTED|CONNECT_FAILED|CONNECTION_ERROR|ECONNREFUSED|EADDRINUSE|10048|app-server.*(?:停止|启动失败)|端口.*占用/i.test(text) ? 'TURN_PREPARATION_ENGINE_UNAVAILABLE'
    : 'TURN_START_PREPARATION_FAILED';
  return { code: reason, message: sanitizeLocalErrorMessage(raw) || '任务准备失败，尚未发送到引擎。' };
}
