import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import type { RelayEnv } from '../auth/authorization.js';
import { presentApiError } from '../contracts/index.js';
import { buildChinaDay, ChinaDayInputError, chinaToday } from '../services/china-day.js';
import { buildChinaCalendarMonth } from '../services/china-calendar.js';
import { buildChinaWeatherRange } from '../services/china-weather-range.js';
import { ChinaDayPanelCache } from '../services/china-day-panel-cache.js';

export function createChinaDayRouter(options: {
  getClientIp?: (context: Parameters<typeof getConnInfo>[0]) => string | undefined;
  build?: typeof buildChinaDay;
  buildCalendarMonth?: typeof buildChinaCalendarMonth;
  buildWeatherRange?: typeof buildChinaWeatherRange;
  cache?: Pick<ChinaDayPanelCache, 'calendar' | 'weather'>;
} = {}) {
  const router = new Hono<RelayEnv>();
  const cache = options.cache ?? new ChinaDayPanelCache();
  router.get('/', async (c) => {
    const city = c.req.query('city');
    const explicitIp = c.req.query('ip');
    const date = c.req.query('date');
    if (city && explicitIp) return c.json(presentApiError('city 和 ip 只能使用一个'), 400);
    const clientIp = options.getClientIp?.(c) ?? getClientIp(c);
    const ip = city ? undefined : explicitIp || clientIp;
    c.header('Cache-Control', 'private, no-store');
    try {
      return c.json(await (options.build ?? buildChinaDay)({ city, ip, date }));
    } catch (error) {
      if (error instanceof ChinaDayInputError) return c.json(presentApiError(error.message), 400);
      return c.json(presentApiError('地区天气日历暂时不可用'), 502);
    }
  });
  router.get('/calendar', async (c) => {
    const year = Number(c.req.query('year'));
    const month = Number(c.req.query('month'));
    const refresh = c.req.query('refresh') === '1';
    c.header('Cache-Control', 'private, no-store');
    try {
      const result = await cache.calendar(year, month, () => (options.buildCalendarMonth ?? buildChinaCalendarMonth)({ year, month }), refresh);
      return c.json({ ...result.value, fetchedAt: result.fetchedAt });
    }
    catch (error) {
      if (error instanceof ChinaDayInputError) return c.json(presentApiError(error.message), 400);
      return c.json(presentApiError('月历暂时不可用'), 502);
    }
  });
  router.get('/weather', async (c) => {
    const city = c.req.query('city');
    const explicitIp = c.req.query('ip');
    const refresh = c.req.query('refresh') === '1';
    if (city && explicitIp) return c.json(presentApiError('city 和 ip 只能使用一个'), 400);
    const clientIp = options.getClientIp?.(c) ?? getClientIp(c);
    const ip = city ? undefined : explicitIp || clientIp;
    const date = chinaToday();
    c.header('Cache-Control', 'private, no-store');
    try {
      const result = await cache.weather(city?.trim() || ip || 'server', date,
        () => (options.buildWeatherRange ?? buildChinaWeatherRange)({ city, ip, date }), refresh);
      return c.json({ ...result.value, fetchedAt: result.fetchedAt });
    }
    catch (error) {
      if (error instanceof ChinaDayInputError) return c.json(presentApiError(error.message), 400);
      return c.json(presentApiError('近期天气暂时不可用'), 502);
    }
  });
  return router;
}

function getClientIp(c: Parameters<typeof getConnInfo>[0]): string | undefined {
  const forwarded = process.env.RELAY_TRUST_PROXY === '1'
    ? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    : undefined;
  let remote: string | undefined;
  try { remote = getConnInfo(c).remote.address; } catch { /* Hono request() tests have no socket. */ }
  const ip = forwarded || remote;
  const normalized = ip?.replace(/^::ffff:/, '');
  if (!normalized || !isIP(normalized)) return undefined;
  // Private addresses locate the LAN, not the visitor's public city.
  if (normalized === '::1' || normalized.startsWith('127.') || normalized.startsWith('10.')
    || normalized.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(normalized)) return undefined;
  return normalized;
}

export default createChinaDayRouter();
