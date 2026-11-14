import type { NewsSourceConfigDto } from '../../generated/relay-contracts';

export type RsshubRoute = 'weibo-hot' | 'weibo-user' | 'weibo-keyword' | 'douyin-user' | 'xiaohongshu-user' | 'wechat-user';

const routes: Record<RsshubRoute, { name: string; path: (value: string) => string; needsTarget: boolean }> = {
  'weibo-hot': { name: '微博热搜', path: () => '/weibo/search/hot', needsTarget: false },
  'weibo-user': { name: '微博账号', path: (value) => `/weibo/user/${value}`, needsTarget: true },
  'weibo-keyword': { name: '微博关键词', path: (value) => `/weibo/keyword/${encodeURIComponent(value)}`, needsTarget: true },
  'douyin-user': { name: '抖音账号', path: (value) => `/douyin/user/${value}`, needsTarget: true },
  'xiaohongshu-user': { name: '小红书账号', path: (value) => `/xiaohongshu/user/${value}/notes`, needsTarget: true },
  'wechat-user': { name: '微信公众号（新榜）', path: (value) => `/newrank/wechat/${value}`, needsTarget: true },
};

export const RSSHUB_ROUTE_OPTIONS = Object.entries(routes).map(([id, route]) => ({ id: id as RsshubRoute, name: route.name, needsTarget: route.needsTarget }));

export function buildRsshubSource(base: string, routeId: RsshubRoute, target: string, label: string, intervalMinutes: number): NewsSourceConfigDto {
  const origin = new URL(base);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password
    || (origin.origin !== 'http://127.0.0.1:1200' && (origin.protocol !== 'https:' || Boolean(origin.port)))) {
    throw new Error('RSSHub 地址须为本机 http://127.0.0.1:1200 或公开 HTTPS 根地址');
  }
  const route = routes[routeId];
  const value = target.trim();
  if (route.needsTarget && (!value || !/^[\p{L}\p{N}._-]{1,100}$/u.test(value))) throw new Error('请填写账号 ID 或关键词，不要填写整条帖子链接');
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 15 || intervalMinutes > 1440) throw new Error('采集间隔须在 15 至 1440 分钟之间');
  const url = new URL(route.path(value), origin);
  return {
    id: `rsshub-${crypto.randomUUID()}`,
    name: `${route.name}${route.needsTarget ? ` · ${label.trim() || value}` : ''}`,
    kind: 'rss_atom', url: url.href, allowedHosts: [url.hostname], enabled: true,
    intervalMinutes, categoryId: 'industry', region: 'cn',
  };
}
