import { getMessageErrorGuidance } from '../messages/message-error-guidance.ts';

export function getFailurePresentation(error: unknown, code?: string) {
  const record = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown; status?: unknown; data?: { code?: unknown } } : {};
  let raw = typeof error === 'string' ? error : typeof record.message === 'string' ? record.message : '';
  if (!raw && error != null) {
    try { raw = JSON.stringify(error) ?? String(error); } catch { raw = String(error); }
  }
  const errorCode = code || (typeof record.data?.code === 'string' ? record.data.code : undefined)
    || (typeof record.code === 'string' ? record.code : undefined)
    || (/^[A-Z][A-Z0-9_]{2,100}$/.test(raw.trim()) ? raw.trim() : undefined);
  const statusCode = typeof record.status === 'number' && record.status > 0 ? String(record.status) : '';
  const guidance = getMessageErrorGuidance(errorCode, `${statusCode} ${raw}`.trim(), { scope: 'request' });
  return {
    description: guidance?.description || '当前操作未能完成。',
    suggestion: guidance?.suggestion || '请核对当前状态和下方原始异常，修正问题后重新操作；持续失败请提供发生时间和操作步骤排查。',
    raw: raw || '服务未提供原始异常信息',
    code: errorCode,
  };
}
