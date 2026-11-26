import { ApiError } from '../api/client.ts';
import { formatDateTime } from '../utils/date-display.ts';

export interface ServiceRestartErrorPresentation {
  title: string;
  detail: string;
  showTerminalFallback: boolean;
  outcomeUnconfirmed?: boolean;
  originalMessage?: string;
  code?: string;
}

export function presentServiceRestartError(
  error: unknown,
  phase: 'status' | 'restart',
): ServiceRestartErrorPresentation {
  const original = { originalMessage: error instanceof Error ? error.message : typeof error === 'string' ? error : '服务未提供原始异常信息',
    ...(error instanceof ApiError && error.data?.code ? { code: error.data.code } : {}) };
  if (error instanceof ApiError && error.data?.code === 'RECOVERY_RESTART_FAILED') {
    return {
      ...original,
      title: '完整重启已取消',
      detail: error.data.error || '完整重启准备失败，现有服务仍在运行。',
      showTerminalFallback: false,
    };
  }
  if (error instanceof ApiError && error.data?.code === 'RECOVERY_RATE_LIMITED') {
    const wait = error.retryAfterSeconds === null ? '片刻' : `${error.retryAfterSeconds} 秒`;
    return {
      ...original,
      title: '重启冷却中',
      detail: `同一服务需间隔 30 秒，前后端交叉操作需间隔 10 秒。请等待 ${wait}后重试。`,
      showTerminalFallback: false,
    };
  }

  const detail = error instanceof ApiError
    ? error.data?.error || error.message
    : error instanceof Error
      ? error.message
      : phase === 'status' ? '无法检测服务状态' : '服务重启失败';
  return {
    ...original,
    title: phase === 'status' ? '状态检测失败' : '重启请求失败',
    detail,
    showTerminalFallback: true,
  };
}

export function formatServiceStartedAt(value: number | null | undefined): string {
  if (!Number.isFinite(value) || value === null || value === undefined) return '未知';
  return formatDateTime(value, { seconds: true, fallback: '未知' });
}
