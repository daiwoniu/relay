import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChinaWeatherHourly } from './china-weather-hourly.js';

const now = Date.parse('2026-12-31T23:25:00+08:00');
function payload() {
  const start = Math.floor(now / 3_600_000) * 3_600_000;
  return { hourly: { time: Array.from({ length: 24 }, (_, i) => new Date(start + i * 3_600_000 + 8 * 3_600_000).toISOString().slice(0, 16)),
    temperature_2m: Array(24).fill(-2), precipitation_probability: [0, 100, null, ...Array(21).fill(30)], weather_code: Array(24).fill(3) } };
}
function fetcher(body = payload(), requested: string[] = []): typeof fetch {
  return (async input => {
    const url = String(input); requested.push(url);
    if (url.includes('get_ip_addr')) return Response.json({ code: 0, data: { city: '济宁', latitude: 35.4, longitude: 116.58 } });
    if (url.includes('/v1/search')) return Response.json({ results: [{ country_code: 'CN', name: '济宁市', latitude: 35.4, longitude: 116.58 }] });
    return Response.json(body);
  }) as typeof fetch;
}

test('hourly forecast requests and validates 24 consecutive Beijing hours across a year boundary', async () => {
  const requested: string[] = [];
  const result = await buildChinaWeatherHourly({ city: '济宁', now, fetcher: fetcher(payload(), requested) });
  assert.equal(result.hours.length, 24);
  assert.equal(result.hours[0].time, '2026-12-31T23:00');
  assert.equal(result.hours[1].time, '2027-01-01T00:00');
  assert.equal(result.hours[23].time, '2027-01-01T22:00');
  assert.equal(result.hours[0].temperatureC, -2);
  assert.deepEqual(result.hours.slice(0, 3).map(hour => hour.precipitationProbabilityPercent), [0, 100, null]);
  const url = new URL(requested.at(-1)!);
  assert.equal(url.searchParams.get('start_hour'), '2026-12-31T23:00');
  assert.equal(url.searchParams.get('end_hour'), '2027-01-01T22:00');
  assert.equal(url.searchParams.get('timezone'), 'Asia/Shanghai');
  assert.ok(!requested.some(url => url.includes('bilibili')));
});

test('visitor IP coordinates skip city geocoding', async () => {
  const requested: string[] = [];
  await buildChinaWeatherHourly({ ip: '203.0.113.11', now, fetcher: fetcher(payload(), requested) });
  assert.equal(requested.length, 2);
  assert.ok(requested[0].includes('get_ip_addr'));
});

test('incomplete, stale and nonconsecutive hourly data fail instead of fabricating missing hours', async () => {
  const changes: Array<(body: ReturnType<typeof payload>) => void> = [body => { body.hourly.time.pop(); }, body => { body.hourly.temperature_2m.pop(); },
    body => { body.hourly.time[0] = '2026-12-31T22:00'; }, body => { body.hourly.time[1] = body.hourly.time[0]; }];
  for (const change of changes) {
    const body = payload(); change(body);
    await assert.rejects(buildChinaWeatherHourly({ city: '济宁', now, fetcher: fetcher(body) }), /逐小时天气/);
  }
});
