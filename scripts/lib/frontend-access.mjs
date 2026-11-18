import {
  getViteAllowedHosts,
  isAllowedRequestHost,
  isConfiguredPublicHost,
} from './relay-config.mjs';
import { lastForwardedIp, normalizeClientIp, resolveProxyClientIp } from './client-ip.mjs';

export const FORWARDED_HEADERS = [
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-for',
  'x-relay-client-address',
  'x-relay-frontend-version',
  'x-real-ip',
  'cf-connecting-ip',
  'forwarded',
];

export function applyShareDocumentHeaders(req, res) {
  const pathname = new URL(req.url || '/', 'http://relay.local').pathname;
  if (!/^\/share(?:\/|$)/.test(pathname)) return false;
  res.setHeader('X-Robots-Tag', 'noindex, noarchive');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return true;
}

export function getAllowedFrontendHosts(config) {
  return getViteAllowedHosts(config);
}

export function isAllowedFrontendHost(host, config) {
  return isAllowedRequestHost(host, config);
}

export function applyTrustedForwardedHeaders(proxyReq, incomingHost, config, clientAddress, forwardedFor) {
  const exactPublicHost = !config.publicAccess.wildcard && isConfiguredPublicHost(incomingHost, config);
  const resolved = resolveProxyClientIp(clientAddress, forwardedFor, config.trustedProxyIps, exactPublicHost);
  for (const header of FORWARDED_HEADERS) proxyReq.removeHeader(header);
  if (resolved) proxyReq.setHeader('X-Relay-Client-Address', resolved);
  if (exactPublicHost && config.trustedProxyIps?.includes(normalizeClientIp(clientAddress)) && lastForwardedIp(forwardedFor)) {
    proxyReq.setHeader('X-Forwarded-For', resolved);
  }
  if (!isConfiguredPublicHost(incomingHost, config)) return false;
  proxyReq.setHeader('X-Forwarded-Proto', 'https');
  proxyReq.setHeader('X-Forwarded-Host', incomingHost);
  return true;
}

export function configureFrontendProxy(proxy, config) {
  proxy.on('proxyReq', (proxyReq, req) => {
    applyTrustedForwardedHeaders(proxyReq, req.headers.host, config, req.socket?.remoteAddress, req.headers['x-forwarded-for']);
  });
  proxy.on('proxyReqWs', (proxyReq, req, socket) => {
    if (!isAllowedFrontendHost(req.headers.host, config)) {
      socket.destroy();
      return;
    }
    applyTrustedForwardedHeaders(proxyReq, req.headers.host, config, req.socket?.remoteAddress, req.headers['x-forwarded-for']);
  });
}
