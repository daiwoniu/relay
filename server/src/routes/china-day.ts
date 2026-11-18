import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import { getHttpClientIp } from '../http-client-ip.js';
import { Hono } from 'hono';
import type { RelayEnv } from '../auth/authorization.js';
import { presentApiError } from '../contracts/index.js';
import { buildChinaDay, ChinaDayInputError, chinaToday } from '../services/china-day.js';
import { buildChinaCalendarMonth } from '../services/china-calendar.js';
import { buildChinaWeatherRange } from '../services/china-weather-range.js';
import { ChinaDayPanelCache } from '../services/china-day-panel-cache.js';
import { WeatherUpstreamError } from '../services/weather-api.js';
import { buildChinaWeatherHourly } from '../services/china-weather-hourly.js';

export function createChinaDayRouter(options: {
  getClientIp?: (context: Parameters<typeof getConnInfo>[0]) => string | undefined;
  build?: typeof buildChinaDay;
  buildCalendarMonth?: typeof buildChinaCalendarMonth;
  buildWeatherRange?: typeof buildChinaWeatherRange;
  buildWeatherHourly?: typeof buildChinaWeatherHourly;
  cache?: Pick<ChinaDayPanelCache, 'calendar' | 'weather'> & Partial<Pick<ChinaDayPanelCache, 'hourly'>>;
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
      return c.json(presentApiError(error instanceof WeatherUpstreamError ? error.message : '近期天气暂时不可用'), 502);
    }
  });
  router.get('/hourly', async (c) => {
    const city = c.req.query('city');
    const explicitIp = c.req.query('ip');
    c.header('Cache-Control', 'private, no-store');
    if (city && explicitIp) return c.json(presentApiError('city 和 ip 只能使用一个'), 400);
    const ip = city ? undefined : explicitIp || (options.getClientIp?.(c) ?? getClientIp(c));
    try {
      const load = () => (options.buildWeatherHourly ?? buildChinaWeatherHourly)({ city, ip });
      const result = cache.hourly
        ? await cache.hourly(city?.trim() || ip || 'server', load, c.req.query('refresh') === '1')
        : { value: await load(), fetchedAt: Date.now() };
      return c.json({ ...result.value, fetchedAt: result.fetchedAt });
    } catch (error) {
      if (error instanceof ChinaDayInputError) return c.json(presentApiError(error.message), 400);
      return c.json(presentApiError(error instanceof WeatherUpstreamError ? error.message : '逐小时天气暂时不可用'), 502);
    }
  });
  return router;
}

function getClientIp(c: Parameters<typeof getConnInfo>[0]): string | undefined {
  const normalized = getHttpClientIp(c);
  if (!normalized || !isIP(normalized)) return undefined;
  // Private addresses locate the LAN, not the visitor's public city.
  if (normalized === '::1' || normalized.startsWith('127.') || normalized.startsWith('10.')
    || normalized.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(normalized)) return undefined;
  return normalized;
}

export default createChinaDayRouter();
