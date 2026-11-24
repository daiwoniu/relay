import { matchRoutes, type RouteObject } from 'react-router-dom';
import type { ReactNode } from 'react';
import { appPageRouteEntries, trackedRoute, type AppPageRoute } from '../../server/src/analytics/pages.ts';

export type PageElements = Record<AppPageRoute, ReactNode>;
type AppRoute = RouteObject & { analyticsPage?: ReturnType<typeof trackedRoute> };

export function createPrivatePageRoutes(elements: PageElements, layoutElement: ReactNode, admin: boolean): AppRoute[] {
  const standalone: AppRoute[] = [];
  const children: AppRoute[] = [];
  for (const [id, route] of appPageRouteEntries) {
    if ((route.admin && !admin) || route.placement === 'public' || route.placement === 'public-prefix') continue;
    const leaf = { id, element: elements[id], analyticsPage: trackedRoute(id) };
    if (route.placement === 'standalone') standalone.push({ ...leaf, path: route.path });
    else if (route.path === '/') children.push({ ...leaf, index: true });
    else children.push({ ...leaf, path: route.path });
  }
  return [...standalone, { path: '/', element: layoutElement, children }];
}

export function privatePageForPath(routes: AppRoute[], pathname: string): ReturnType<typeof trackedRoute> | 'unknown' {
  const matches = matchRoutes(routes, { pathname });
  const leaf = matches?.[matches.length - 1].route;
  return leaf?.analyticsPage === undefined ? 'unknown' : leaf.analyticsPage;
}
