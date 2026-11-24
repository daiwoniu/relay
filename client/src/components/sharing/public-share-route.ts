import { publicPageForPath } from '../../../../server/src/analytics/pages.ts';

export function isPublicSharePath(pathname: string): boolean {
  return publicPageForPath(pathname) === 'public_share';
}
