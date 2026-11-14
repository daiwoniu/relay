import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createChinaDayRouter } from './china-day.js';
import { buildChinaDay, ChinaDayInputError, chinaToday } from '../services/china-day.js';
import { ChinaDayPanelCache } from '../services/china-day-panel-cache.js';

test('route passes query and client IP into shared service', async () => {
  let received: Parameters<typeof buildChinaDay>[0];
  const router = createChinaDayRouter({
    getClientIp: () => '39.85.243.125',
    build: (async (options) => {
      received = options;
      return { date: '2026-10-01' } as Awaited<ReturnType<typeof buildChinaDay>>;
    }) as typeof buildChinaDay,
  });
  const response = await router.request('http://localhost/?date=2026-10-01');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(received, { city: undefined, ip: '39.85.243.125', date: '2026-10-01' });
});

test('route rejects conflicting location inputs', async () => {
  const router = createChinaDayRouter();
  const response = await router.request('http://localhost/?city=济宁&ip=39.85.243.125');
  assert.equal(response.status, 400);
});

test('weather route preserves actionable location errors as HTTP 400', async () => {
  const message = '未找到 甘肃 的天气坐标，请输入具体城市或区县';
  const router = createChinaDayRouter({
    cache: { calendar: async () => { throw new Error('unexpected calendar call'); },
      weather: async (_city, _date, load) => ({ value: await load(), fetchedAt: Date.now() }) },
    buildWeatherRange: async () => { throw new ChinaDayInputError(message); },
  });
  const response = await router.request('http://localhost/weather?city=甘肃');
  assert.equal(response.status, 400);
  assert.match(await response.text(), /请输入具体城市或区县/);
});

test('month and weather routes share backend cache and allow manual refresh', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-china-routes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calendarCalls = 0;
  let weatherCalls = 0;
  const router = createChinaDayRouter({
    cache: new ChinaDayPanelCache(root),
    buildCalendarMonth: (async ({ year, month }: { year: number; month: number }) => ({ year, month, days: [], warnings: [], marker: ++calendarCalls })) as any,
    buildWeatherRange: (async ({ city, date }: { city?: string; date?: string }) => ({ date, location: { city }, days: [], source: 'open-meteo', marker: ++weatherCalls })) as any,
  });
  const calendar = await router.request('http://localhost/calendar?year=2026&month=10');
  assert.equal(calendar.status, 200);
  const firstMonth = await calendar.json() as any;
  assert.equal(firstMonth.marker, 1);
  assert.equal(typeof firstMonth.fetchedAt, 'number');
  assert.equal((await (await router.request('http://localhost/calendar?year=2026&month=10')).json() as any).marker, 1);
  assert.equal((await (await router.request('http://localhost/calendar?year=2026&month=10&refresh=1')).json() as any).marker, 2);
  const weather = await router.request('http://localhost/weather?city=济宁');
  assert.equal(weather.status, 200);
  const firstWeather = await weather.json() as any;
  assert.equal(firstWeather.marker, 1);
  assert.equal(firstWeather.date, chinaToday());
  assert.equal(typeof firstWeather.fetchedAt, 'number');
  assert.equal((await (await router.request('http://localhost/weather?city=济宁')).json() as any).marker, 1);
  assert.equal((await (await router.request('http://localhost/weather?city=济宁&refresh=1')).json() as any).marker, 2);
  const conflict = await router.request('http://localhost/weather?city=济宁&ip=39.85.243.125');
  assert.equal(conflict.status, 400);
});
