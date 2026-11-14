import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChinaWeatherRange } from './china-weather-range.js';
import { ChinaDayInputError } from './china-day.js';

test('weather range shows previous three days, today and following seven days', async () => {
  const requested: string[] = [];
  const dates = Array.from({ length: 11 }, (_, index) => `2026-10-${String(index + 12).padStart(2, '0')}`);
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/v1/search')) return new Response(JSON.stringify({ results: [
      { name: '济宁', country_code: 'CN', latitude: 35.4, longitude: 116.58 },
    ] }));
    if (url.includes('/v1/forecast')) return new Response(JSON.stringify({ daily: {
      time: dates, weather_code: dates.map(() => 3),
      temperature_2m_max: dates.map(() => 22), temperature_2m_min: dates.map(() => 11),
      precipitation_sum: dates.map(() => 0.5), precipitation_probability_max: dates.map(() => 20),
    } }));
    throw new Error(`Unexpected URL: ${url}`);
  };
  const result = await buildChinaWeatherRange({ city: '济宁', date: '2026-10-15', fetcher: fetcher as typeof fetch });
  assert.deepEqual(result.days.map((day) => day.kind), ['past', 'past', 'past', 'today', ...Array(7).fill('forecast')]);
  assert.deepEqual(result.location, { city: '济宁', latitude: 35.4, longitude: 116.58 });
  assert.equal(result.days[3]?.highC, 22);
  assert.match(requested.find((url) => url.includes('/v1/forecast')) ?? '', /past_days=3/);
  assert.match(requested.find((url) => url.includes('/v1/forecast')) ?? '', /forecast_days=8/);
});

test('weather range rejects a different city returned by geocoding', async () => {
  const fetcher = async (input: string | URL | Request) => {
    if (String(input).includes('/v1/search')) return new Response(JSON.stringify({ results: [
      { name: '济南', country_code: 'CN', latitude: 36.67, longitude: 117 },
    ] }));
    throw new Error('forecast must not use coordinates from another city');
  };
  await assert.rejects(buildChinaWeatherRange({ city: '济宁', fetcher: fetcher as typeof fetch }), /未找到 济宁 的天气坐标/);
});

for (const city of ['酒泉', '酒泉市']) {
  test(`weather range resolves full Chinese city name for ${city}`, async () => {
    const names: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/search') {
        const name = url.searchParams.get('name')!;
        names.push(name);
        return Response.json(name === '酒泉市' ? { results: [
          { name: '酒泉市', country_code: 'CN', latitude: 39.74318, longitude: 98.51736, feature_code: 'PPLA2' },
        ] } : {});
      }
      assert.equal(url.searchParams.get('latitude'), '39.74318');
      assert.equal(url.searchParams.get('longitude'), '98.51736');
      return Response.json({ daily: { time: ['2026-11-11'] } });
    };
    const result = await buildChinaWeatherRange({ city, fetcher: fetcher as typeof fetch });
    assert.equal(result.location.latitude, 39.74318);
    assert.deepEqual(names, ['酒泉市']);
  });
}

test('weather range prefers Qingdao city over a same-named village', async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/search') {
      const city = url.searchParams.get('name') === '青岛市';
      return Response.json({ results: [city
        ? { name: '青岛市', country_code: 'CN', latitude: 36.06488, longitude: 120.38042 }
        : { name: '青岛', country_code: 'CN', latitude: 39.32908, longitude: 121.73279 }] });
    }
    assert.equal(url.searchParams.get('latitude'), '36.06488');
    return Response.json({ daily: { time: [] } });
  };
  const result = await buildChinaWeatherRange({ city: '青岛', fetcher: fetcher as typeof fetch });
  assert.equal(result.location.longitude, 120.38042);
});

test('city names ending in 州 still try the full city name', async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/search') {
      assert.equal(url.searchParams.get('name'), '兰州市');
      return Response.json({ results: [{ name: '兰州市', country_code: 'CN', latitude: 36.06, longitude: 103.83 }] });
    }
    return Response.json({ daily: { time: [] } });
  };
  assert.equal((await buildChinaWeatherRange({ city: '兰州', fetcher: fetcher as typeof fetch })).location.longitude, 103.83);
});

test('province-only and unknown locations return an actionable input error', async () => {
  for (const results of [[], [{ name: '甘肃', country_code: 'CN', feature_code: 'ADM1', latitude: 38, longitude: 102 }]]) {
    const fetcher = async (input: string | URL | Request) => {
      assert.match(String(input), /\/v1\/search/);
      return Response.json({ results });
    };
    await assert.rejects(buildChinaWeatherRange({ city: '甘肃', fetcher: fetcher as typeof fetch }),
      (error: unknown) => error instanceof ChinaDayInputError && /请输入具体城市或区县/.test(error.message));
  }
});
