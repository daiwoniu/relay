import type { Context, Next } from 'hono';
import { presentApiError } from '../contracts/index.js';
import { getSessionTokenFromCookieHeader } from './cookie.js';
import { authenticateSessionDetails, authenticateSessionToken } from './service.js';
import type { RelayEnv } from './authorization.js';
import { isPasswordChangeAllowedRequest } from './public-paths.js';
export { isPasswordChangeAllowedRequest } from './public-paths.js';

export function authenticateCookieHeader(cookieHeader?: string | null) {
  return authenticateSessionToken(getSessionTokenFromCookieHeader(cookieHeader));
}

export function authenticateCookieSession(cookieHeader?: string | null) {
  return authenticateSessionDetails(getSessionTokenFromCookieHeader(cookieHeader));
}

export async function requireUserSession(c: Context<RelayEnv>, next: Next) {
  const user = authenticateCookieHeader(c.req.header('cookie'));
  if (!user) return c.json(presentApiError('请先登录'), 401);
  if (!isPasswordChangeAllowedRequest(user, c.req.path)) {
    return c.json(presentApiError('首次登录必须先修改密码', { code: 'PASSWORD_CHANGE_REQUIRED' }), 403);
  }
  c.set('relayActor', { userId: user.id, role: user.role });
  return next();
}
