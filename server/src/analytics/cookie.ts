import { CLIENT_ID_COOKIE_NAME,getClientIdFromCookieHeader,parseCookieHeader,serializeClientIdCookie } from '../auth/cookie.js';

export const ANALYTICS_COOKIE_NAME='relay_analytics_id';

export function getAnalyticsCookie(header?:string|null):string|null{
  const value=parseCookieHeader(header)[ANALYTICS_COOKIE_NAME];
  return value?getClientIdFromCookieHeader(`${CLIENT_ID_COOKIE_NAME}=${encodeURIComponent(value)}`):null;
}

export function getAnalyticsVisitorId(header?:string|null):string|null{
  // Adopt an existing browser ID without ever changing the login intent/rate-limit cookie.
  return getAnalyticsCookie(header)??getClientIdFromCookieHeader(header);
}

export function serializeAnalyticsCookie(id:string,secure:boolean):string{
  return serializeClientIdCookie(id,secure).replace(`${CLIENT_ID_COOKIE_NAME}=`,`${ANALYTICS_COOKIE_NAME}=`);
}
