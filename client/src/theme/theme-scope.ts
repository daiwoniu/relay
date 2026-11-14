import { isPublicSharePath } from '../components/sharing/public-share-route.ts';

export type ThemeScope = 'workspace' | 'guest' | 'public-share' | 'public-news' | 'public-tools';
export type ThemeAuthStatus = 'loading' | 'error' | 'authenticated' | 'guest';

export function resolveThemeScope(pathname: string, status: ThemeAuthStatus): ThemeScope {
  if (isPublicSharePath(pathname)) return 'public-share';
  if (pathname === '/news') return 'public-news';
  if (pathname === '/tools') return 'public-tools';
  return status === 'guest' ? 'guest' : 'workspace';
}
