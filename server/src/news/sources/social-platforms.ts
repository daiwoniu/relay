export const SOCIAL_PLATFORMS = {
  wechat: { name: '微信公众号 · 原帖', hosts: ['mp.weixin.qq.com'] },
  xiaohongshu: { name: '小红书 · 原帖', hosts: ['xiaohongshu.com'] },
  douyin: { name: '抖音 · 原帖', hosts: ['douyin.com'] },
  kuaishou: { name: '快手 · 原帖', hosts: ['kuaishou.com'] },
  weibo: { name: '微博 · 原帖', hosts: ['weibo.com', 'weibo.cn'] },
} as const;

export type SocialPlatform = keyof typeof SOCIAL_PLATFORMS;

export function socialSourceNames(): Array<[string, string]> {
  return Object.entries(SOCIAL_PLATFORMS).map(([id, platform]) => [`social-${id}`, platform.name]);
}

export function sourceIdsForRegion(sources: Array<{ id: string; region?: string }>, region: 'cn' | 'global'): string[] {
  return [
    ...sources.filter((source) => (source.region ?? 'global') === region).map((source) => source.id),
    ...(region === 'cn' ? socialSourceNames().map(([id]) => id) : []),
  ];
}

export function validSocialUrl(platform: SocialPlatform, raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password) return false;
    return SOCIAL_PLATFORMS[platform].hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}
