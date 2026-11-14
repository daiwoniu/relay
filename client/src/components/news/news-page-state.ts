export const NEWS_REFRESH_MIN_MS = 120_000;
export const NEWS_REFRESH_JITTER_MS = 60_000;

export function newsRefreshDelay(random = Math.random): number {
  return NEWS_REFRESH_MIN_MS + Math.floor(random() * NEWS_REFRESH_JITTER_MS);
}

export function safeNewsReturnPath(raw: string | null): string | null {
  return raw === '/news' ? raw : null;
}

export function relativeNewsTime(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
