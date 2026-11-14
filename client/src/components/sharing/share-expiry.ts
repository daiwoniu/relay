import type { ShareExpiry, ShareManagementStatus } from '../../generated/relay-contracts';

export const SHARE_EXPIRY_OPTIONS = [
  { value: '1h', label: '1 小时' },
  { value: '1d', label: '1 天' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: 'custom', label: '自定义' },
  { value: 'permanent', label: '永久有效' },
] as const;

export type ShareExpiryOption = typeof SHARE_EXPIRY_OPTIONS[number]['value'];

export function buildShareExpiry(option: ShareExpiryOption, customValue: string, now = Date.now()): ShareExpiry {
  if (option === 'permanent') return { type: 'permanent' };
  if (option !== 'custom') return { type: 'preset', value: option };
  const expiresAt = new Date(customValue).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt < now + 10 * 60 * 1000 || expiresAt > now + 90 * 24 * 60 * 60 * 1000) {
    throw new Error('自定义有效期必须在 10 分钟至 90 天之间');
  }
  return { type: 'custom', expiresAt };
}

export function getShareStatusLabel(status: ShareManagementStatus, expiresAt: number | null, now = Date.now()): string {
  if (status === 'revoked') return '已取消';
  if (status === 'expired') return '已过期';
  if (expiresAt === null) return '永久有效';
  const remaining = expiresAt - now;
  if (remaining <= 60 * 60 * 1000) return '即将过期';
  return '有效';
}
