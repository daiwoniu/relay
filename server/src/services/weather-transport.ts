import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';

const WEATHER_HOSTS = new Set(['api.open-meteo.com', 'geocoding-api.open-meteo.com']);
const isMappedAddress = (address: string) => /^198\.(?:18|19)\./.test(address);

function publicV4(address: unknown): address is string {
  if (typeof address !== 'string' || isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a !== 0 && a !== 10 && a !== 127 && a < 224 && !isMappedAddress(address)
    && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
    && !(a === 192 && b === 168) && !(a === 100 && b >= 64 && b <= 127);
}

function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** Keep the original hostname/SNI and normal certificate verification; replace only DNS lookup. */
function fetchAtAddress(url: URL, address: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers));
    headers['accept-encoding'] = 'identity';
    const request = https.get(url, { headers, signal: init.signal ?? undefined, family: 4,
      lookup: (_hostname, _options, callback) => callback(null, address, 4) }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) { request.destroy(new Error('WEATHER_RESPONSE_TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const status = response.statusCode ?? 502;
          resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks),
            { status, headers: { 'content-type': String(response.headers['content-type'] ?? 'application/json') } }));
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
  });
}

/** Only mapped weather GETs use scoped DNS; failed nodes fall back within the caller's deadline. */
export function createWeatherTransport(options: {
  fetch?: typeof fetch;
  lookup?: (hostname: string) => Promise<Array<{ address: string }>>;
  direct?: (url: URL, address: string, init: RequestInit) => Promise<Response>;
  clock?: () => number;
} = {}): typeof fetch {
  const normalFetch = options.fetch ?? fetch;
  const resolveSystem = options.lookup ?? (hostname => lookup(hostname, { all: true }));
  const direct = options.direct ?? fetchAtAddress;
  const clock = options.clock ?? Date.now;
  const cache = new Map<string, { address: string; expiresAt: number; resolverHost: string }>();
  return async (input, init = {}) => {
    const original = input instanceof Request ? input : null;
    const url = new URL(original?.url ?? String(input));
    const method = (init.method ?? original?.method ?? 'GET').toUpperCase();
    if (url.protocol !== 'https:' || !WEATHER_HOSTS.has(url.hostname) || method !== 'GET') return normalFetch(input, init);
    const signal = init.signal ?? original?.signal ?? AbortSignal.timeout(8_000);
    signal.throwIfAborted();
    let addresses: Array<{ address: string }>;
    try { addresses = await withSignal(resolveSystem(url.hostname), signal); }
    catch (error) { signal.throwIfAborted(); return normalFetch(input, init); }
    if (!addresses.some(item => isMappedAddress(item.address))) return normalFetch(input, init);

    let cached = cache.get(url.hostname);
    if (cached && cached.expiresAt <= clock()) cached = undefined;
    const resolverHosts = ['dns.alidns.com', 'dns.google'];
    // A cached alternate must be able to fail back to the primary, rather than retry itself.
    const cachedResolver = cached?.resolverHost;
    const orderedResolvers = cachedResolver
      ? [cachedResolver, ...resolverHosts.filter(host => host !== cachedResolver)] : resolverHosts;
    let lastError: unknown;
    for (const [index, resolverHost] of orderedResolvers.entries()) {
      const attemptSignal = index === 0 ? AbortSignal.any([signal, AbortSignal.timeout(3_000)]) : signal;
      try {
        if (!cached || cached.expiresAt <= clock()) {
          const resolver = new URL(`https://${resolverHost}/resolve`);
          resolver.search = new URLSearchParams({ name: url.hostname, type: 'A' }).toString();
          const response = await normalFetch(resolver, { signal: attemptSignal, headers: { Accept: 'application/dns-json' } });
          if (!response.ok) throw new Error('WEATHER_DNS_UNAVAILABLE');
          const body = await response.json();
          const answer = Array.isArray(body?.Answer) ? body.Answer.find((item: any) => item.type === 1 && publicV4(item.data)) : null;
          if (body.Status !== 0 || !answer) throw new Error('WEATHER_DNS_INVALID_ANSWER');
          const ttl = typeof answer.TTL === 'number' && Number.isFinite(answer.TTL) ? Math.max(0, Math.min(answer.TTL, 300)) : 30;
          cached = { address: answer.data, expiresAt: clock() + ttl * 1000, resolverHost };
        }
        signal.throwIfAborted();
        const response = await direct(url, cached.address, { ...init, headers: init.headers ?? original?.headers, signal: attemptSignal });
        if (!response.ok) throw new Error('WEATHER_UPSTREAM_UNAVAILABLE');
        cache.set(url.hostname, cached);
        return response;
      } catch (error) {
        signal.throwIfAborted();
        lastError = error;
        cached = undefined;
        cache.delete(url.hostname);
      }
    }
    throw lastError;
  };
}
