import { getConnInfo } from '@hono/node-server/conninfo';
import { resolveBackendClientIp } from '../../scripts/lib/client-ip.mjs';

type HttpContext = Parameters<typeof getConnInfo>[0];
export function getHttpPeerAddress(c: HttpContext): string | undefined {
  try { return getConnInfo(c).remote.address; } catch { return undefined; }
}

/** Called behind the backend access-token boundary; never trust raw client-supplied XFF. */
export function getHttpClientIp(c: HttpContext, remoteAddress = getHttpPeerAddress(c)): string {
  return resolveBackendClientIp(remoteAddress, c.req.header('x-relay-client-address'));
}
