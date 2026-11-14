import type { CodexSystemNotice } from './protocol.js';

/** Retry errors are progress, not terminal failures. Keep provider details off the UI. */
export function presentRetryNotice(params: any, sequence: number): CodexSystemNotice {
  const text = [params.error?.message, params.error?.additionalDetails]
    .filter((value): value is string => typeof value === 'string').join(' ');
  const attempt = text.match(/\b(\d{1,3})\s*\/\s*(\d{1,3})\b/);
  const delay = text.match(/\bin\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i);
  const retryDelayMs = delay ? Math.round(Number(delay[1]) * (delay[2].toLowerCase() === 's' ? 1000 : 1)) : undefined;
  const retryAttempt = attempt ? Number(attempt[1]) : undefined;
  const maxRetries = attempt ? Number(attempt[2]) : undefined;
  const disconnected = /disconnect|reconnect|connection|1005[34]/i.test(text)
    || Boolean(params.error?.codexErrorInfo?.responseStreamDisconnected);
  return {
    type: 'system_notice',
    noticeType: 'warning',
    title: `${disconnected ? '模型连接中断' : '模型请求暂时异常'}，已触发第 ${sequence} 次自动重试`,
    message: `${retryAttempt !== undefined && maxRetries !== undefined ? `本次重试 ${retryAttempt}/${maxRetries}。` : ''}${retryDelayMs !== undefined ? `等待 ${retryDelayMs} 毫秒后重试。` : ''}回合仍在处理中，无需重复发送。`,
    details: { kind: 'engine_retry' },
  };
}
