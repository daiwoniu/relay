import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChinaDay } from './china-day.js';

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

test('combines client IP location, CMA weather and Chinese calendar', async () => {
  const requested: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('get_ip_addr')) return json({ code: 0, data: {
      country: '中国', province: '山东', city: '济宁', latitude: '35.4025', longitude: '116.580307',
    } });
    if (url.includes('/api/autocomplete')) return json({ code: 0, data: [
      '53480|集宁|Jining|中国', '54915|济宁|Jining|中国',
    ] });
    if (url.includes('/api/weather/view')) return json({ code: 0, data: {
      location: { id: '54915', name: '济宁' },
      now: { precipitation: 0.2, temperature: 21.1, humidity: 36, windDirection: '西北风', windSpeed: 3.2 },
      daily: [{ date: '2026/10/01', high: 22, low: 9, dayText: '小雨', nightText: '多云' }],
      lastUpdate: '2026/10/01 18:05',
    } });
    if (url.includes('/2026.json')) return json({ year: 2026, days: [
      { date: '2026-10-01', name: '国庆节', isOffDay: true },
    ] });
    throw new Error(`Unexpected URL: ${url}`);
  };

  const day = await buildChinaDay({ ip: '39.85.243.125', date: '2026-10-01', fetcher: fetcher as typeof fetch });
  assert.equal(day.location?.city, '济宁');
  assert.equal(day.weather?.stationId, '54915');
  assert.equal(day.weather?.precipitationMm, 0.2);
  assert.equal(day.weather?.forecast?.dayText, '小雨');
  assert.equal(day.calendar.lunarDate, '二〇二六年八月廿一');
  assert.deepEqual(day.calendar.solarFestivals, ['国庆节']);
  assert.deepEqual(day.calendar.holidayArrangement, { name: '国庆节', isOffDay: true });
  assert.deepEqual(day.warnings, []);
  assert.ok(requested.some((url) => url.includes('ip=39.85.243.125')));
});

test('city input skips IP location and preserves solar terms when weather fails', async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('bilibili')) throw new Error('IP lookup should not run');
    if (url.includes('/api/autocomplete')) return json({ code: 0, data: ['54915|济宁|Jining|中国'] });
    if (url.includes('/api/weather/view')) throw new Error('CMA unavailable');
    if (url.includes('/2026.json')) return json({ year: 2026, days: [] });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const day = await buildChinaDay({ city: '济宁', date: '2026-10-08', fetcher: fetcher as typeof fetch });
  assert.equal(day.location?.source, 'manual');
  assert.equal(day.weather, null);
  assert.equal(day.calendar.solarTerm, '寒露');
  assert.match(day.warnings.join(' '), /天气获取失败/);
});
