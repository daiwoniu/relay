import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { applyTrustedForwardedHeaders } from '../../scripts/lib/frontend-access.mjs';
import type { RelayConfig } from '../../scripts/lib/relay-config.mjs';
import { normalizeClientIp, MAX_FORWARDED_HEADER_LENGTH, MAX_FORWARDED_HEADER_IPS } from '../../scripts/lib/client-ip.mjs';

export const IP_DIAGNOSTIC_PATH = '/__relay/ip-diagnostic';
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

function inspectHeader(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value.join(',') : value;
  if (raw === undefined) return null;
  if (raw.length > MAX_FORWARDED_HEADER_LENGTH) return { omitted: true, ips: [], invalidCount: null, lastIp: null };
  const parts = raw.split(',');
  if (parts.length > MAX_FORWARDED_HEADER_IPS) return { omitted: true, ips: [], invalidCount: null, lastIp: null };
  const ips = parts.map(value => normalizeClientIp(value) ?? null);
  return { omitted: false, ips, invalidCount: ips.filter(ip => !ip).length, lastIp: ips.at(-1) ?? null };
}

async function readWindow(filename: string | undefined): Promise<number | null> {
  if (!filename) return null;
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile() || stat.size > 1024) return null;
    const { createdAt, expiresAt } = JSON.parse(await fs.readFile(filename, 'utf8'));
    const now = Date.now();
    return Number.isSafeInteger(createdAt) && Number.isSafeInteger(expiresAt)
      && createdAt <= now && expiresAt > now && expiresAt > createdAt && expiresAt - createdAt <= MAX_WINDOW_MS
      ? expiresAt : null;
  } catch { return null; }
}

/** Read-only observation. Header candidates never become trusted client addresses here. */
export async function handleFrontendIpDiagnostic(request: IncomingMessage, response: ServerResponse, options: {
  windowFile?: string;
  backendTarget: string;
  accessToken: string;
  relayConfig: RelayConfig;
}) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Robots-Tag', 'noindex, noarchive');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const reply = (status: number, value: unknown) => { response.statusCode = status; response.end(JSON.stringify(value)); };
  const expiresAt = await readWindow(options.windowFile);
  if (!expiresAt) { reply(404, { error: '诊断入口未启用或已过期' }); return; }
  if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); reply(405, { error: '仅允许 GET' }); return; }
  if (request.headers['sec-fetch-site'] === 'cross-site' || request.headers.origin === 'null') {
    reply(403, { error: '不允许跨站访问诊断入口' }); return;
  }
  if (request.headers.origin) {
    try {
      const origin = new URL(request.headers.origin);
      if (!['http:', 'https:'].includes(origin.protocol)
        || origin.host !== new URL(`${origin.protocol}//${request.headers.host}`).host) throw new Error();
    } catch { reply(403, { error: '不允许跨站访问诊断入口' }); return; }
  }
  if (!request.headers.cookie) { reply(401, { error: '请先登录管理员账号' }); return; }
  try {
    // Reuse the backend's live session/revocation checks; never open its database or return its user projection.
    const headers = new Headers({ cookie: request.headers.cookie, 'x-relay-token': options.accessToken });
    applyTrustedForwardedHeaders({
      removeHeader: (name: string) => headers.delete(name),
      setHeader: (name: string, value: string) => headers.set(name, value),
    }, request.headers.host, options.relayConfig, request.socket.remoteAddress, request.headers['x-forwarded-for']);
    const auth = await fetch(new URL('/api/auth/me', options.backendTarget), {
      headers, redirect: 'manual', signal: AbortSignal.timeout(3000),
    });
    if (!auth.ok) {
      await auth.body?.cancel();
      reply(auth.status === 401 ? 401 : auth.status === 403 ? 403 : 503, { error: '管理员身份验证未通过' }); return;
    }
    const chunks: Uint8Array[] = []; let bytes = 0;
    if (!auth.body) throw new Error();
    for await (const chunk of auth.body) {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1024) throw new Error();
      chunks.push(chunk);
    }
    const { user } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (user?.role !== 'admin' || user.mustChangePassword !== false) {
      reply(403, { error: '仅已完成改密的管理员可查看诊断' }); return;
    }
    // A slow identity check must not extend the local opt-in window.
    if (Date.now() >= expiresAt || await readWindow(options.windowFile) !== expiresAt) {
      reply(404, { error: '诊断入口未启用或已过期' }); return;
    }
    const socketPeer = normalizeClientIp(request.socket.remoteAddress) ?? null;
    const observedHeaders = Object.fromEntries(
      ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'x-relay-client-address']
        .map(name => [name, inspectHeader(request.headers[name])]),
    );
    reply(200, {
      observedAt: new Date().toISOString(), expiresAt: new Date(expiresAt).toISOString(), socketPeer,
      observedHeaders, headerCandidatesTrusted: false,
      forwardedForAccepted: headers.has('x-forwarded-for'),
      currentGatewayClientAddress: headers.get('x-relay-client-address'),
      currentGatewayForwardedFor: headers.get('x-forwarded-for'),
    });
  } catch { reply(503, { error: '诊断身份校验暂不可用，请稍后重试' }); }
}
