import { randomUUID } from 'node:crypto';
import { ACCEPTANCE_SESSION_TTL_MS, SESSION_TTL_MS } from './session.js';

export const SESSION_COOKIE_NAME = 'relay_session';
export const CLIENT_ID_COOKIE_NAME = 'relay_client_id';
const CLIENT_ID_TTL_SECONDS = 365 * 24 * 60 * 60;

export function parseCookieHeader(header?: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function getSessionTokenFromCookieHeader(header?: string | null): string | null {
  return parseCookieHeader(header)[SESSION_COOKIE_NAME] || null;
}

export function getClientIdFromCookieHeader(header?: string | null): string | null {
  const value = parseCookieHeader(header)[CLIENT_ID_COOKIE_NAME];
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

export function createClientId(): string {
  return randomUUID();
}

export function serializeClientIdCookie(clientId: string, secure: boolean): string {
  const attributes = [
    `${CLIENT_ID_COOKIE_NAME}=${encodeURIComponent(clientId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${CLIENT_ID_TTL_SECONDS}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function serializeSessionCookie(token: string, expiresAt: number, secure: boolean, ttlMs = SESSION_TTL_MS): string {
  if (ttlMs !== SESSION_TTL_MS && ttlMs !== ACCEPTANCE_SESSION_TTL_MS) throw new Error('会话有效期不在允许范围内');
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function serializeClearSessionCookie(secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}
