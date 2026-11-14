import { Hono } from 'hono';
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { presentApiError } from '../contracts/index.js';
import { shareService, type ShareService } from '../services/shares.js';
import { PublicShareRateLimiter } from '../shares/public-rate-limit.js';
import { isAllowedOrigin } from '../security.js';

const PUBLIC_TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
const defaultLimiter = new PublicShareRateLimiter();

function getPublicClientId(c: Parameters<typeof getConnInfo>[0]): string {
  const trustedProxyAddress = c.req.header('x-relay-client-address')?.trim();
  const forwarded = process.env.RELAY_TRUST_PROXY === '1'
    ? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    : undefined;
  return (trustedProxyAddress || forwarded || getConnInfo(c).remote.address || 'local').slice(0, 128);
}

export function createPublicSharesRouter({
  service = shareService,
  limiter = defaultLimiter,
  getClientId = getPublicClientId,
  isOriginAllowed = isAllowedOrigin,
}: {
  service?: Pick<ShareService, 'readPublic'>;
  limiter?: PublicShareRateLimiter;
  getClientId?: (context: Context) => string;
  isOriginAllowed?: (origin?: string | null) => boolean;
} = {}) {
  const router = new Hono();
  router.get('/:token', (c) => {
    const token = c.req.param('token');
    const headers = {
      'X-Robots-Tag': 'noindex, noarchive',
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    };
    if (!isOriginAllowed(c.req.header('origin'))) return c.json(presentApiError('不允许的请求来源'), 403, headers);
    if (!PUBLIC_TOKEN_PATTERN.test(token)) return c.json({ state: 'not_found' as const }, 404, headers);
    if (!limiter.consume(`${getClientId(c)}:${token}`)) {
      return c.json(presentApiError('请求过于频繁'), 429, headers);
    }
    const result = service.readPublic(token);
    const status = result.state === 'not_found' ? 404 : 200;
    return c.json(result, status, headers);
  });
  return router;
}

export default createPublicSharesRouter();
