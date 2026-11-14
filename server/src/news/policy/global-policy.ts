import { isIP } from 'node:net';
import { z } from 'zod';
import type { NewsSource } from '../sources/source-types.js';
import { isLocalRsshubUrl } from '../sources/rsshub-local.js';

const terms = z.array(z.string().trim().min(1).max(200)).max(200);
export const GlobalNewsPolicySchema = z.object({
  blockedDomains: terms,
  blockedKeywords: terms,
  blockedUrls: z.array(z.string().url().max(2048)).max(200),
}).strict();
export type GlobalNewsPolicy = z.infer<typeof GlobalNewsPolicySchema>;
export const DEFAULT_GLOBAL_NEWS_POLICY: GlobalNewsPolicy = { blockedDomains: [], blockedKeywords: [], blockedUrls: [] };

export const NewsSourceConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['rss_atom', 'github_releases', 'hacker_news']),
  url: z.string().url().max(2048),
  allowedHosts: z.array(z.string().min(1).max(255)).min(1).max(5),
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(15).max(1440),
  categoryId: z.string().regex(/^[a-z0-9_]{2,64}$/),
  region: z.enum(['cn', 'global']).optional(),
  disabledReason: z.string().max(500).optional(),
}).strict();

function safeHost(host: string): boolean {
  return Boolean(host && host.includes('.') && !isIP(host) && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(host));
}

export function validateSourceConfig(input: unknown): NewsSource {
  const source = NewsSourceConfigSchema.parse(input);
  const url = new URL(source.url);
  if (isLocalRsshubUrl(source.url)) {
    if (source.kind !== 'rss_atom' || source.allowedHosts.length !== 1 || source.allowedHosts[0] !== '127.0.0.1') throw new RangeError('RSSHub 本机来源配置无效');
    return source;
  }
  if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password || !safeHost(url.hostname)) throw new RangeError('来源地址必须是公开 HTTPS 域名');
  if (source.allowedHosts.some((host) => !safeHost(host) || host !== host.toLowerCase())) throw new RangeError('受信任域名无效');
  if (!source.allowedHosts.includes(url.hostname)) throw new RangeError('来源域名未列入受信任域名');
  if (source.kind === 'hacker_news' && source.url !== 'https://hacker-news.firebaseio.com/v0/newstories.json') throw new RangeError('Hacker News 仅支持固定 API');
  if (source.kind === 'github_releases' && !/^https:\/\/api\.github\.com\/repos\/[\w.-]+\/[\w.-]+\/releases(?:\?per_page=\d+)?$/.test(source.url)) throw new RangeError('仅支持 GitHub Releases API');
  return source;
}

export function matchesGlobalBlock(item: { url: string; title: string; description: string | null }, policy: GlobalNewsPolicy): string | null {
  const host = new URL(item.url).hostname.toLowerCase();
  for (const domain of policy.blockedDomains) {
    const target = domain.toLowerCase();
    if (host === target || host.endsWith(`.${target}`)) return `domain:${domain}`;
  }
  if (policy.blockedUrls.includes(item.url)) return 'url';
  const text = `${item.title} ${item.description ?? ''}`.toLowerCase();
  for (const word of policy.blockedKeywords) if (text.includes(word.toLowerCase())) return `keyword:${word}`;
  return null;
}
