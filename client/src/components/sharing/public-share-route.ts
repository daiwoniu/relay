export function isPublicSharePath(pathname: string): boolean {
  return /^\/share(?:\/|$)/.test(pathname);
}
