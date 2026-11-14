export function isUnauthenticatedApiRequest(method: string, path: string): boolean {
  return path === '/api/health'
    || path === '/api/auth/login'
    || (method === 'GET' && path.startsWith('/api/public/shares/'))
    || (method === 'GET' && ['/api/public/tools/china-day', '/api/public/tools/china-day/calendar', '/api/public/tools/china-day/weather'].includes(path))
    || (method === 'GET' && (path === '/api/public/news' || path === '/api/public/news/version'));
}

export function isPasswordChangeAllowedRequest(user: { mustChangePassword: boolean }, path: string): boolean {
  return !user.mustChangePassword
    || path === '/api/auth/me'
    || path === '/api/auth/change-password'
    || path === '/api/auth/logout';
}
