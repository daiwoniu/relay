import dns from 'node:dns/promises';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

export interface RawResponse {
  status: number;
  headers: Record<string, string | null>;
  body: Buffer;
}

export interface SafeFetchDependencies {
  resolve(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>>;
  request(url: URL, address: string, options: { family: 4 | 6; signal: AbortSignal; headers: Record<string, string>; maxBytes: number }): Promise<RawResponse>;
}

export interface SafeFetchOptions {
  allowedHosts: string[];
  signal?: AbortSignal;
  etag?: string;
  lastModified?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

const blocked = new BlockList();
for (const [subnet, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(subnet, prefix, 'ipv4');

function isPublicIp(input: string, allowTunAddress = false): boolean {
  const address = input.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIp(mapped[1]!);
  const family = isIP(address);
  if (family === 4) {
    // 本机 TUN 代理可把真实 HTTPS 域名映射到 198.18/15；仅接受域名解析结果，仍由 TLS 校验原域名。
    const parts = address.split('.').map(Number);
    if (allowTunAddress && parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
    return !blocked.check(address, 'ipv4');
  }
  if (family === 6) {
    if (address === '::' || address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe8') || address.startsWith('fe9') || address.startsWith('fea') || address.startsWith('feb') || address.startsWith('ff') || address.startsWith('2001:db8:')) return false;
    return /^[23][0-9a-f]/.test(address);
  }
  return false;
}

async function resolvePublic(hostname: string, resolve: SafeFetchDependencies['resolve']): Promise<{ address: string; family: 4 | 6 }> {
  const literalFamily = isIP(hostname.replace(/^\[|\]$/g, ''));
  const addresses = literalFamily
    ? [{ address: hostname.replace(/^\[|\]$/g, ''), family: literalFamily as 4 | 6 }]
    : await resolve(hostname);
  if (!addresses.length || addresses.some((entry) => !isPublicIp(entry.address, !literalFamily))) throw new Error('资讯来源必须解析到公网地址');
  return addresses[0]!;
}

function headerValue(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] ?? null : null;
}

const nodeDependencies: SafeFetchDependencies = {
  resolve: async (hostname) => (await dns.lookup(hostname, { all: true, verbatim: true })) as Array<{ address: string; family: 4 | 6 }>,
  request: (url, address, options) => new Promise<RawResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const request = https.request(url, {
      method: 'GET', signal: options.signal, headers: options.headers,
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) (callback as (error: null, addresses: Array<{ address: string; family: 4 | 6 }>) => void)(null, [{ address, family: options.family }]);
        else (callback as (error: null, address: string, family: 4 | 6) => void)(null, address, options.family);
      },
    }, (response) => {
      if (response.socket.remoteAddress && response.socket.remoteAddress !== address) {
        response.destroy(new Error('资讯来源实际连接地址不匹配'));
        return;
      }
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > options.maxBytes) { response.destroy(new RangeError('资讯响应超过 2 MiB')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: {
          location: headerValue(response.headers.location), etag: headerValue(response.headers.etag),
          'last-modified': headerValue(response.headers['last-modified']),
          'retry-after': headerValue(response.headers['retry-after']),
          'content-encoding': headerValue(response.headers['content-encoding']),
        },
        body: Buffer.concat(chunks),
      }));
    });
    request.on('error', reject);
    request.end();
  }),
};

export async function safeFetch(input: string, options: SafeFetchOptions, dependencies: SafeFetchDependencies = nodeDependencies): Promise<RawResponse> {
  const allowed = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
  const timeout = AbortSignal.timeout(Math.min(options.timeoutMs ?? 8000, 8000));
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const maxBytes = Math.min(options.maxBytes ?? 2 * 1024 * 1024, 2 * 1024 * 1024);
  let current = new URL(input);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    if (current.protocol !== 'https:') throw new Error('资讯来源只允许 HTTPS 协议');
    if (current.port && current.port !== '443') throw new Error('资讯来源只允许标准 HTTPS 端口');
    if (current.username || current.password) throw new Error('资讯来源地址不能携带凭据');
    if (!allowed.has(current.hostname.toLowerCase())) throw new Error('资讯来源域名未获允许');
    const { address, family } = await resolvePublic(current.hostname, dependencies.resolve);
    const headers: Record<string, string> = { Accept: 'application/rss+xml, application/atom+xml, application/json, application/xml;q=0.8, */*;q=0.1', 'Accept-Encoding': 'gzip, br, deflate', 'User-Agent': 'Relay-AI-News/1.0' };
    if (options.etag) headers['If-None-Match'] = options.etag;
    if (options.lastModified) headers['If-Modified-Since'] = options.lastModified;
    const response = await dependencies.request(current, address, { family, signal, headers, maxBytes });
    if (response.body.length > maxBytes) throw new RangeError('资讯响应超过 2 MiB');
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location) throw new Error('资讯来源重定向缺少目标');
      current = new URL(location, current);
      continue;
    }
    const encoding = response.headers['content-encoding']?.toLowerCase();
    if (response.status !== 304 && encoding) {
      try {
        if (encoding === 'gzip') response.body = gunzipSync(response.body, { maxOutputLength: maxBytes });
        else if (encoding === 'br') response.body = brotliDecompressSync(response.body, { maxOutputLength: maxBytes });
        else if (encoding === 'deflate') response.body = inflateSync(response.body, { maxOutputLength: maxBytes });
        else if (encoding !== 'identity') throw new Error('资讯来源使用不支持的压缩格式');
      } catch (error) {
        if (error instanceof Error && error.message.includes('larger than')) throw new RangeError('资讯响应解压后超过 2 MiB');
        throw error;
      }
      if (response.body.length > maxBytes) throw new RangeError('资讯响应解压后超过 2 MiB');
    }
    return response;
  }
  throw new Error('资讯来源重定向次数过多');
}
