import type { CreateShareRequest, ShareManagementStatus } from '../contracts/index.js';

export const SHARE_TITLE_MAX_LENGTH = 120;
export const SHARE_MESSAGE_IDS_MAX = 200;
export const SHARE_SNAPSHOT_MESSAGE_MAX = 500;
export const SHARE_SNAPSHOT_BYTES_MAX = 2 * 1024 * 1024;
export const SHARE_CUSTOM_MIN_MS = 10 * 60 * 1000;
export const SHARE_CUSTOM_MAX_MS = 90 * 24 * 60 * 60 * 1000;

const PRESET_EXPIRY_MS = {
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
} as const;

export function validateShareSelection(request: CreateShareRequest): string | undefined {
  if (request.scope === 'session') return undefined;
  if (request.scope === 'single' && request.messageIds.length !== 1) {
    return '单条消息分享必须且只能选择一条消息';
  }
  if (request.scope === 'selection' && request.messageIds.length === 0) {
    return '多选分享至少需要选择一条消息';
  }
  return undefined;
}

export function resolveShareExpiry(
  expiry: CreateShareRequest['expiry'],
  now = Date.now(),
): number | null {
  if (expiry.type === 'permanent') return null;
  if (expiry.type === 'preset') return now + PRESET_EXPIRY_MS[expiry.value];
  const lifetime = expiry.expiresAt - now;
  if (lifetime < SHARE_CUSTOM_MIN_MS || lifetime > SHARE_CUSTOM_MAX_MS) {
    throw new Error('自定义有效期必须在 10 分钟至 90 天之间');
  }
  return expiry.expiresAt;
}

export function getShareManagementStatus(
  record: { expiresAt: number | null; revokedAt: number | null },
  now = Date.now(),
): ShareManagementStatus {
  if (record.revokedAt !== null) return 'revoked';
  if (record.expiresAt !== null && record.expiresAt <= now) return 'expired';
  return 'active';
}
