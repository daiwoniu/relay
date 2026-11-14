import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isConfiguredPublicHost,
  isLocalOrPrivateHost,
  isPublicOriginAllowed,
  loadRelayConfig,
  type RelayConfig,
} from '../../scripts/lib/relay-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = process.env.RELAY_TOKEN_FILE
  ? path.resolve(process.env.RELAY_TOKEN_FILE)
  : path.resolve(__dirname, '..', 'data', 'access-token');
const RELAY_CONFIG = loadRelayConfig(path.resolve(__dirname, '..', '..', 'config', 'relay.conf'));

function loadOrCreateAccessToken(): string {
  const configured = process.env.RELAY_ACCESS_TOKEN?.trim();
  if (configured) return configured;

  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  try {
    fs.writeFileSync(TOKEN_PATH, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
  }
  return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
}

const ACCESS_TOKEN = loadOrCreateAccessToken();

export function isAllowedOrigin(
  origin?: string | null,
  configuredOrigins = process.env.ALLOWED_ORIGINS || '',
  relayConfig: RelayConfig = RELAY_CONFIG,
): boolean {
  if (!origin) return true;

  const explicit = configuredOrigins.split(',').map((item) => item.trim()).filter(Boolean);
  if (explicit.includes(origin)) return true;

  try {
    const url = new URL(origin);
    return (['http:', 'https:'].includes(url.protocol) && isLocalOrPrivateHost(url.host))
      || isPublicOriginAllowed(origin, relayConfig);
  } catch {
    return false;
  }
}

export function isTrustedForwardedHttps(
  forwardedProto?: string | null,
  forwardedHost?: string | null,
  relayConfig: RelayConfig = RELAY_CONFIG,
  legacyTrustProxy = process.env.RELAY_TRUST_PROXY === '1',
): boolean {
  const proto = forwardedProto?.split(',')[0]?.trim().toLowerCase();
  const host = forwardedHost?.split(',')[0]?.trim();
  if (proto !== 'https') return false;
  return legacyTrustProxy || isConfiguredPublicHost(host, relayConfig);
}

export function isSecureRelayRequest(
  requestUrl: string,
  forwardedProto?: string | null,
  forwardedHost?: string | null,
  relayConfig: RelayConfig = RELAY_CONFIG,
  legacyTrustProxy = process.env.RELAY_TRUST_PROXY === '1',
): boolean {
  return requestUrl.startsWith('https://')
    || isTrustedForwardedHttps(forwardedProto, forwardedHost, relayConfig, legacyTrustProxy);
}

export function isValidAccessToken(provided?: string | null, expected = ACCESS_TOKEN): boolean {
  if (!expected) return true;
  if (!provided) return false;

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length
    && timingSafeEqual(providedBuffer, expectedBuffer);
}

export function extractAccessToken(
  authorization?: string | null,
  relayHeader?: string | null,
  queryToken?: string | null,
): string | null {
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7).trim();
  return relayHeader?.trim() || queryToken?.trim() || null;
}

export function isAccessTokenConfigured(): boolean {
  return Boolean(ACCESS_TOKEN);
}
