import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedWeatherFetch, openMeteoCurrent, WeatherUpstreamError } from './weather-api.js';

const location = { city: '济宁', latitude: 35.4, longitude: 116.58 };
const date = '2026-11-17';
const current = { time: `${date}T21:00`, temperature_2m: 0, precipitation: 0, weather_code: 0 };

test('API current weather preserves zero values and does not depend on daily forecast data', async () => {
  const requested: string[] = [];
  const fetcher = (async input => { requested.push(String(input)); return Response.json({ current }); }) as typeof fetch;
  const result = await openMeteoCurrent(fetcher, location, date);
  assert.equal(result.temperatureC, 0);
  assert.equal(result.precipitationMm, 0);
  assert.equal(result.forecast.dayText, '晴');
  assert.equal(result.forecast.highC, null);
  assert.equal(result.source, 'open-meteo');
  assert.equal(requested.length, 1);
  assert.equal(new URL(requested[0]).hostname, 'api.open-meteo.com');
});

test('API includes same-date maximum temperature at night without any webpage fallback', async () => {
  const result = await openMeteoCurrent((async () => Response.json({ current,
    daily: { time: [date], temperature_2m_max: [13], temperature_2m_min: [6] } })) as typeof fetch, location, date);
  assert.equal(result.forecast.highC, 13);
  assert.equal(result.forecast.lowC, 6);
  const stale = await openMeteoCurrent((async () => Response.json({ current,
    daily: { time: ['2026-11-16'], temperature_2m_max: [99] } })) as typeof fetch, location, date);
  assert.equal(stale.forecast.highC, null);
});

test('stale or missing observations fail with controlled API diagnostics', async () => {
  for (const body of [{ current: { ...current, time: '2026-11-16T21:00' } }, { current: { ...current, temperature_2m: null } }, {}]) {
    await assert.rejects(openMeteoCurrent((async () => Response.json(body)) as typeof fetch, location, date), /Open-Meteo 实况天气/);
  }
  const failure = new WeatherUpstreamError('Open-Meteo', new Error('private upstream URL', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }));
  assert.match(failure.message, /连接超时/);
  assert.doesNotMatch(failure.message, /private/);
});

test('request deadline retains caller cancellation', async () => {
  let combined: AbortSignal | null | undefined;
  const controller = new AbortController();
  await boundedWeatherFetch((async (_input, init) => { combined = init?.signal; return Response.json({}); }) as typeof fetch)
    ('https://api.open-meteo.com/', { signal: controller.signal });
  assert.equal(combined?.aborted, false);
  controller.abort();
  assert.equal(combined?.aborted, true);
});

test('numeric DOMException codes do not mask transport timeout diagnostics', () => {
  assert.match(new WeatherUpstreamError('Open-Meteo', new DOMException('timeout', 'TimeoutError')).message, /连接超时/);
  assert.match(new WeatherUpstreamError('Open-Meteo', Object.assign(new Error('aborted'), { code: 20 })).message, /连接失败/);
});
