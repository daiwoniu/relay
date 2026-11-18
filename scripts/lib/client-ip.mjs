import { isIP } from 'node:net';

export const MAX_FORWARDED_HEADER_LENGTH = 4096;
export const MAX_FORWARDED_HEADER_IPS = 32;

export function normalizeClientIp(value) {
  if (typeof value !== 'string') return undefined;
  const ip = value.trim();
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) !== 6) return undefined;
  try {
    const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
    if (!mapped) return normalized;
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
  } catch { return undefined; }
}

export function isLoopbackIp(value) {
  const ip = normalizeClientIp(value);
  return ip === '::1' || Boolean(ip && /^127\./.test(ip));
}

// Supported upstreams must append their direct visitor address, as SakuraFrp does.
// Earlier values are visitor-controlled; an invalid final value must never promote them.
export function lastForwardedIp(value) {
  const raw = Array.isArray(value) ? value.join(',') : value;
  if (typeof raw !== 'string' || raw.length > MAX_FORWARDED_HEADER_LENGTH) return undefined;
  const parts = raw.split(',');
  return parts.length <= MAX_FORWARDED_HEADER_IPS ? normalizeClientIp(parts.at(-1)) : undefined;
}

export function resolveProxyClientIp(remoteAddress, forwardedFor, trustedProxyIps, exactPublicHost) {
  const remote = normalizeClientIp(remoteAddress);
  if (!remote || !exactPublicHost || !trustedProxyIps?.includes(remote)) return remote;
  return lastForwardedIp(forwardedFor) || remote;
}

// The backend token boundary authenticates the gateway; only a loopback connection
// may additionally provide its canonical internal client address. Raw XFF is never read.
export function resolveBackendClientIp(remoteAddress, relayClientAddress) {
  const remote = normalizeClientIp(remoteAddress);
  const header = Array.isArray(relayClientAddress)
    ? relayClientAddress.length === 1 ? relayClientAddress[0] : undefined : relayClientAddress;
  return (isLoopbackIp(remote) && normalizeClientIp(header)) || remote || 'local';
}
