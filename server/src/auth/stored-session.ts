import type { Context, Next } from 'hono';
import type { CoreStoragePort } from '../storage/contracts.js';
import { presentApiError } from '../contracts/index.js';
import type { RelayEnv } from './authorization.js';
import { getSessionTokenFromCookieHeader } from './cookie.js';
import { hashSessionToken } from './session.js';
import { isPasswordChangeAllowedRequest } from './public-paths.js';

/** Failures reject instead of masquerading as an invalid login. Tokens remain in the HTTP process. */
export async function authenticateStoredSession(token: string | null | undefined, port: Pick<CoreStoragePort, 'authenticateSession'>) {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const result = await port.authenticateSession({ tokenHash });
  return result ? { ...result, tokenHash } : null;
}

/** Selected only when the application's entire service graph uses the same Worker store. */
export function createRequireStoredUserSession(port: Pick<CoreStoragePort, 'authenticateSession'>) {
  return async (c: Context<RelayEnv>, next: Next) => {
    let session: Awaited<ReturnType<typeof authenticateStoredSession>>;
    try { session = await authenticateStoredSession(getSessionTokenFromCookieHeader(c.req.header('cookie')), port); }
    catch { return c.json(presentApiError('存储暂不可用，请稍后重试', { code: 'STORAGE_UNAVAILABLE' }), 503); }
    if (!session) return c.json(presentApiError('请先登录'), 401);
    if (!isPasswordChangeAllowedRequest(session.user, c.req.path)) {
      return c.json(presentApiError('首次登录必须先修改密码', { code: 'PASSWORD_CHANGE_REQUIRED' }), 403);
    }
    c.set('relayActor', { userId: session.user.id, role: session.user.role });
    c.set('relayAuthSession', session);
    c.set('relayStoragePrincipal', { kind: 'user', userId: session.user.id, authSessionHash: session.tokenHash });
    return next();
  };
}
