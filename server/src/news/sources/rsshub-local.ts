import http from 'node:http';
import type { RawResponse } from './safe-fetch.js';

const LOCAL_ORIGIN = 'http://127.0.0.1:1200';
const ROUTES = [
  /^\/weibo\/user\/\d+$/,
  /^\/weibo\/keyword\/[^/]+$/,
  /^\/weibo\/search\/hot$/,
  /^\/douyin\/user\/[A-Za-z0-9_-]+$/,
  /^\/xiaohongshu\/user\/[A-Za-z0-9_-]+\/notes$/,
  /^\/newrank\/wechat\/[A-Za-z0-9_-]+$/,
  /^\/newrank\/douyin\/[A-Za-z0-9_-]+$/,
];

export function isLocalRsshubUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.origin === LOCAL_ORIGIN && !url.username && !url.password && !url.search && !url.hash
      && ROUTES.some((route) => route.test(url.pathname));
  } catch { return false; }
}

export function fetchLocalRsshub(raw: string, signal: AbortSignal): Promise<RawResponse> {
  if (!isLocalRsshubUrl(raw)) return Promise.reject(new Error('RSSHub 本机来源地址无效'));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const request = http.get(raw, {
      signal, agent: false,
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml', 'User-Agent': 'Relay-AI-News/1.0' },
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        response.resume();
        reject(new Error('RSSHub 本机来源不允许重定向'));
        return;
      }
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) { response.destroy(new RangeError('RSSHub 响应超过 2 MiB')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: { location: null, etag: typeof response.headers.etag === 'string' ? response.headers.etag : null,
          'last-modified': typeof response.headers['last-modified'] === 'string' ? response.headers['last-modified'] : null,
          'retry-after': typeof response.headers['retry-after'] === 'string' ? response.headers['retry-after'] : null },
        body: Buffer.concat(chunks),
      }));
    });
    request.on('error', reject);
  });
}
