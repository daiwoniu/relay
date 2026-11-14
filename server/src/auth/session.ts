import { createHash, randomBytes } from 'node:crypto';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ACCEPTANCE_SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashSessionToken(token) };
}

export function getSessionExpiry(now = Date.now(), ttlMs = SESSION_TTL_MS): number {
  if (ttlMs !== SESSION_TTL_MS && ttlMs !== ACCEPTANCE_SESSION_TTL_MS) {
    throw new Error('会话有效期不在允许范围内');
  }
  return now + ttlMs;
}
