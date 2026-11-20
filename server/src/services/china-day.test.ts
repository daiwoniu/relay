import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChinaDay, locationFor } from './china-day.js';

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

test('location diagnostics distinguish provider rejection from unknown city without exposing visitor IP', async () => {
  const ip = '2001:db8::123';
  let requested = '';
  const fetcher = (async (input: string | URL | Request) => {
    requested = String(input);
    return json({ code: -412, message: `blocked ${ip}` });
  }) as typeof fetch;
  await assert.rejects(locationFor(fetcher, ip), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /访客 IPv6，错误码 -412/);
    assert.ok(!error.message.includes(ip));
    assert.doesNotMatch(error.message, /未返回城市/);
    return true;
  });
  assert.equal(new URL(requested).searchParams.get('ip'), ip);
  for (const [address, target] of [[ip, '访客 IPv6'], ['192.0.2.1', '访客 IPv4'], [undefined, '服务器出口 IP']] as const) {
    const noCity = (async () => json({ code: 0, data: { city: '  ' } })) as typeof fetch;
    await assert.rejects(locationFor(noCity, address), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`查询成功但未返回城市（${target}）`));
      return true;
    });
  }
});

test('location diagnostics do not reflect arbitrary provider codes', async () => {
  const fetcher = (async () => json({ code: 'private upstream payload' })) as typeof fetch;
  await assert.rejects(locationFor(fetcher, '192.0.2.1'), /地区接口请求失败（访客 IPv4，错误码 未知）/);
});

test('combines visitor IP location, API weather and Chinese calendar without webpage requests', async () => {
  const requested: string[] = [];
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('get_ip_addr')) return json({ code: 0, data: {
      country: '中国', province: '山东', city: '济宁', latitude: '35.4025', longitude: '116.580307',
    } });
    if (url.includes('/v1/forecast')) return json({
      current: { time: '2026-10-01T18:05', precipitation: 0.2, temperature_2m: 21.1, weather_code: 61 },
      daily: { time: ['2026-10-01'], temperature_2m_max: [22], temperature_2m_min: [9] },
    });
    if (url.includes('/2026.json')) return json({ year: 2026, days: [
      { date: '2026-10-01', name: '国庆节', isOffDay: true },
    ] });
    throw new Error(`Unexpected URL: ${url}`);
  };

  const day = await buildChinaDay({ ip: '39.85.243.125', date: '2026-10-01', fetcher: fetcher as typeof fetch });
  assert.equal(day.location?.city, '济宁');
  assert.equal(day.weather?.stationName, '济宁');
  assert.equal(day.weather?.source, 'open-meteo');
  assert.equal(day.weather?.precipitationMm, 0.2);
  assert.equal(day.weather?.forecast?.dayText, '雨');
  assert.equal(day.weather?.forecast?.highC, 22);
  assert.equal(day.calendar.lunarDate, '二〇二六年八月廿一');
  assert.deepEqual(day.calendar.solarFestivals, ['国庆节']);
  assert.deepEqual(day.calendar.holidayArrangement, { name: '国庆节', isOffDay: true });
  assert.deepEqual(day.warnings, []);
  assert.ok(requested.some((url) => url.includes('ip=39.85.243.125')));
  assert.ok(requested.every(url => ['api.live.bilibili.com', 'api.open-meteo.com', 'raw.githubusercontent.com'].includes(new URL(url).hostname)));
});

test('city input skips IP location and preserves solar terms when weather fails', async () => {
  const fetcher = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('bilibili')) throw new Error('IP lookup should not run');
    if (url.includes('/v1/search')) return json({ results: [{ name: '济宁市', country_code: 'CN', latitude: 35.4, longitude: 116.58 }] });
    if (url.includes('/v1/forecast')) throw new Error('API unavailable');
    if (url.includes('/2026.json')) return json({ year: 2026, days: [] });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const day = await buildChinaDay({ city: '济宁', date: '2026-10-08', fetcher: fetcher as typeof fetch });
  assert.equal(day.location?.source, 'manual');
  assert.equal(day.weather, null);
  assert.equal(day.calendar.solarTerm, '寒露');
  assert.match(day.warnings.join(' '), /天气获取失败/);
});
