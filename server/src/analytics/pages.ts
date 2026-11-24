type PageRoute = {
  path: string;
  placement: 'public' | 'public-prefix' | 'standalone' | 'layout';
  label: string | null;
  admin?: boolean;
};

// Route keys are stable analytics IDs. Use a null label to skip page views.
export const appPageRoutes = {
  tools: { path: '/tools', placement: 'public', label: '工具集' },
  news: { path: '/news', placement: 'public', label: 'AI情报' },
  public_share: { path: '/share', placement: 'public-prefix', label: '公开分享' },
  news_admin: { path: '/admin/news', placement: 'standalone', label: '资讯管理', admin: true },
  analytics_admin: { path: '/admin/analytics', placement: 'standalone', label: '访问统计', admin: true },
  feishu_bots: { path: '/admin/feishu-bots', placement: 'standalone', label: '飞书管理', admin: true },
  chat: { path: '/', placement: 'layout', label: '对话' },
  page_hosting_admin: { path: '/admin/page-hosting', placement: 'layout', label: '页面托管管理', admin: true },
  task_workbench: { path: '/admin/task-workbench', placement: 'layout', label: '任务工作台' },
} as const satisfies Record<string, PageRoute>;

export type AppPageRoute = keyof typeof appPageRoutes;
type TrackedRoute = { [K in AppPageRoute]: (typeof appPageRoutes)[K]['label'] extends null ? never : K }[AppPageRoute];

const otherPageLabels = {
  login: '登录页',
  password_change: '首次改密',
  hosting: '托管页面',
  unknown: '未识别',
} as const;

export type AnalyticsPage = TrackedRoute | keyof typeof otherPageLabels;
export const appPageRouteEntries = (Object.keys(appPageRoutes) as AppPageRoute[])
  .map((id): [AppPageRoute, PageRoute] => [id, appPageRoutes[id]]);

export function publicPageForPath(pathname: string) {
  return appPageRouteEntries.find(([, route]) =>
    (route.placement === 'public' && pathname === route.path) ||
    (route.placement === 'public-prefix' && (pathname === route.path || pathname.startsWith(`${route.path}/`))),
  )?.[0];
}

export function trackedRoute(id: AppPageRoute): TrackedRoute | null {
  return appPageRoutes[id].label === null ? null : id as TrackedRoute;
}

export const analyticsPageLabels = {
  ...otherPageLabels,
  ...Object.fromEntries(appPageRouteEntries.flatMap(([id, { label }]) => label === null ? [] : [[id, label]])),
} as Record<AnalyticsPage, string>;

export const analyticsPageIds = Object.keys(analyticsPageLabels) as [AnalyticsPage, ...AnalyticsPage[]];
