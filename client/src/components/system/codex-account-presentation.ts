export function formatCodexAccountEmail(email: string | null): string {
  if (!email) return '未显示邮箱';
  const at = email.indexOf('@');
  if (at <= 0) return '已连接账号';
  return `${email.slice(0, Math.min(3, at))}***${email.slice(at)}`;
}

export function formatCodexResetTime(resetsAt: number | null): string | null {
  if (!resetsAt) return null;
  const value = new Date(resetsAt * 1000);
  if (Number.isNaN(value.getTime())) return null;
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hour = String(value.getHours()).padStart(2, '0');
  const minute = String(value.getMinutes()).padStart(2, '0');
  return `下次重置：${month}-${day} ${hour}:${minute}`;
}

export function formatCodexFetchedAt(fetchedAt: number): string {
  const value = new Date(fetchedAt);
  if (Number.isNaN(value.getTime())) return '读取时间未知';
  return `读取于 ${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}:${String(value.getSeconds()).padStart(2, '0')}`;
}

export function formatCodexPlanType(planType: string | null): string {
  if (!planType) return '未提供';
  return planType.slice(0, 1).toUpperCase() + planType.slice(1);
}

export function formatCodexLimitName(limitName: string | null, limitId: string): string {
  const normalized = (limitName || limitId).toLowerCase();
  if (normalized === 'gpt-reserve' || normalized === 'gpt_reserve') return 'GPT 保留额度';
  if (normalized === 'base_model_inference') return '基础模型调用额度';
  if (normalized === 'codex') return 'Codex 使用额度';
  return limitName || limitId;
}

export function formatCodexLimitWindow(limit: { windowType: 'primary' | 'secondary'; windowDurationMins: number | null }): string {
  if (limit.windowDurationMins === 300) return '5 小时窗口';
  if (limit.windowDurationMins === 10080) return '7 天窗口';
  if (limit.windowDurationMins && limit.windowDurationMins % 1440 === 0) return `${limit.windowDurationMins / 1440} 天窗口`;
  if (limit.windowDurationMins) return `${limit.windowDurationMins} 分钟窗口`;
  return limit.windowType === 'secondary' ? '次窗口' : '主窗口';
}

export function formatCodexRateLimitReason(limit: { rateLimitReachedType: string | null; spendControlReached: boolean }): string | null {
  if (limit.spendControlReached) return '消费控制已触发';
  if (limit.rateLimitReachedType) return '已触发限额';
  return null;
}


export function formatCodexTokenCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '未提供';
  const absolute = Math.abs(value);
  if (absolute >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (absolute >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return Math.round(value).toLocaleString('en-US');
}

export function sortCodexUsageBucketsNewestFirst<T extends { startDate: string }>(buckets: T[]): T[] {
  return [...buckets].sort((left, right) => right.startDate.localeCompare(left.startDate));
}

export function getCodexAccountStatusLabel(account: { status: 'ready' | 'unavailable'; authMode: string }): string {
  if (account.status !== 'ready') return '额度暂时不可用';
  if (account.authMode === 'apikey') return 'API Key 计费';
  if (account.authMode === 'chatgpt' || account.authMode === 'chatgptAuthTokens') return '官方账号已连接';
  return '账号状态已读取';
}
