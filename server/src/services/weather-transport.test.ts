import assert from 'node:assert/strict';
import test from 'node:test';
import { createWeatherTransport } from './weather-transport.js';
import { WeatherUpstreamError } from './weather-api.js';

const target = 'https://api.open-meteo.com/v1/forecast?latitude=35.4&longitude=116.58';
const answer = (address = '51.81.167.44', ttl = 30) => ({ Status: 0, Answer: [{ type: 1, data: address, TTL: ttl }] });

test('mapped weather DNS uses a scoped resolver, preserving original hostname, path, headers and cancellation', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const transport = createWeatherTransport({ lookup: async () => [{ address: '198.18.1.24' }],
    fetch: (async (input, init) => {
      const url = new URL(String(input)); calls.push(url.hostname);
      assert.equal(url.hostname, 'dns.alidns.com');
      assert.equal(url.searchParams.get('name'), 'api.open-meteo.com');
      assert.equal(url.searchParams.get('type'), 'A');
      assert.equal(init?.signal?.aborted, false);
      assert.equal(new Headers(init?.headers).has('authorization'), false);
      return Response.json(answer());
    }) as typeof fetch,
    direct: async (url, address, init) => {
      assert.equal(url.href, target);
      assert.equal(url.hostname, 'api.open-meteo.com');
      assert.equal(address, '51.81.167.44');
      assert.equal(init.signal?.aborted, false);
      assert.equal(new Headers(init.headers).get('accept'), 'application/json');
      return Response.json({ ok: true });
    },
  });
  assert.deepEqual(await (await transport(target, { signal: controller.signal, headers: { Accept: 'application/json' } })).json(), { ok: true });
  assert.deepEqual(calls, ['dns.alidns.com']);
});

test('normal DNS, unrelated domains and non-GET calls retain the ordinary fetch path', async () => {
  let lookups = 0, requests = 0;
  const transport = createWeatherTransport({ lookup: async () => { lookups++; return [{ address: '51.81.167.44' }]; },
    fetch: (async () => { requests++; return Response.json({}); }) as typeof fetch,
    direct: async () => { throw new Error('unexpected direct connection'); } });
  await transport(target);
  await transport('https://example.com/');
  await transport(target, { method: 'POST' });
  await transport('http://api.open-meteo.com/');
  assert.equal(lookups, 1);
  assert.equal(requests, 4);
});

test('public DNS results expire according to TTL instead of hardcoding an upstream IP', async () => {
  let now = 0, resolutions = 0;
  const transport = createWeatherTransport({ clock: () => now, lookup: async () => [{ address: '198.19.0.1' }],
    fetch: (async () => { resolutions++; return Response.json(answer()); }) as typeof fetch,
    direct: async () => Response.json({}) });
  await transport(target);
  now = 29_000; await transport(target); assert.equal(resolutions, 1);
  now = 30_000; await transport(target); assert.equal(resolutions, 2);
});

test('resolver errors and private/synthetic answers never reach the direct connection', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.1.1', '198.18.1.24', '224.0.0.1', 'invalid']) {
    const transport = createWeatherTransport({ lookup: async () => [{ address: '198.18.1.24' }],
      fetch: (async () => Response.json(answer(address))) as typeof fetch,
      direct: async () => { throw new Error('must not connect'); } });
    await assert.rejects(transport(target), /WEATHER_DNS_INVALID_ANSWER/);
  }
  const failed = createWeatherTransport({ lookup: async () => [{ address: '198.18.1.24' }],
    fetch: (async () => new Response('', { status: 503 })) as typeof fetch });
  await assert.rejects(failed(target), /WEATHER_DNS_UNAVAILABLE/);
});

test('aborting during system lookup prevents subsequent DNS/HTTPS requests', async () => {
  const controller = new AbortController();
  let finish!: (value: Array<{ address: string }>) => void;
  const transport = createWeatherTransport({ lookup: () => new Promise(resolve => { finish = resolve; }),
    fetch: (async () => { throw new Error('must not fetch'); }) as typeof fetch });
  const request = transport(target, { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, error => error instanceof Error && error.name === 'AbortError');
  finish([{ address: '198.18.1.24' }]);
});

test('TLS validation failures remain failures with safe diagnostics', async () => {
  const certificateError = Object.assign(new Error('certificate detail'), { code: 'CERT_HAS_EXPIRED' });
  const transport = createWeatherTransport({ lookup: async () => [{ address: '198.18.1.24' }],
    fetch: (async () => Response.json(answer())) as typeof fetch,
    direct: async () => { throw certificateError; } });
  await assert.rejects(transport(target), error => error === certificateError);
  assert.match(new WeatherUpstreamError('Open-Meteo', certificateError).message, /证书已过期/);
});

test('unreachable primary node falls back to alternate DNS and caches only the successful address', async () => {
  const resolvers: string[] = [], addresses: string[] = [];
  const transport = createWeatherTransport({ lookup: async () => [{ address: '198.18.0.42' }],
    fetch: (async input => {
      const host = new URL(String(input)).hostname; resolvers.push(host);
      return Response.json(answer(host === 'dns.google' ? '167.114.211.86' : '51.81.167.44'));
    }) as typeof fetch,
    direct: async (_url, address) => {
      addresses.push(address);
      if (address === '51.81.167.44') throw new DOMException('timeout', 'TimeoutError');
      return Response.json({ ok: true });
    } });
  await transport(target);
  await transport(target);
  assert.deepEqual(resolvers, ['dns.alidns.com', 'dns.google']);
  assert.deepEqual(addresses, ['51.81.167.44', '167.114.211.86', '167.114.211.86']);
});

test('caller cancellation during a node attempt prevents fallback resolution', async () => {
  const controller = new AbortController();
  let resolutions = 0;
  const transport = createWeatherTransport({ lookup: async () => [{ address: '198.18.0.42' }],
    fetch: (async () => { resolutions++; return Response.json(answer()); }) as typeof fetch,
    direct: async (_url, _address, init) => {
      controller.abort();
      init.signal?.throwIfAborted();
      throw new Error('expected abort');
    } });
  await assert.rejects(transport(target, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(resolutions, 1);
});

test('a cached alternate node failure can recover through the primary resolver', async () => {
  let primaryRecovered = false;
  const resolvers: string[] = [];
  const transport = createWeatherTransport({ lookup: async () => [{ address: '198.18.0.42' }],
    fetch: (async input => {
      const host = new URL(String(input)).hostname; resolvers.push(host);
      return Response.json(answer(host === 'dns.google' ? '167.114.211.86' : '51.81.167.44'));
    }) as typeof fetch,
    direct: async (_url, address) => {
      if ((address === '51.81.167.44') !== primaryRecovered) throw new Error('node unreachable');
      return Response.json({ ok: true });
    } });
  await transport(target);
  primaryRecovered = true;
  await transport(target);
  assert.deepEqual(resolvers, ['dns.alidns.com', 'dns.google', 'dns.alidns.com']);
});

test('Request input retains its own abort signal', async () => {
  const controller = new AbortController(); controller.abort();
  let lookups = 0;
  const transport = createWeatherTransport({ lookup: async () => { lookups++; return []; } });
  await assert.rejects(transport(new Request(target, { signal: controller.signal })), { name: 'AbortError' });
  assert.equal(lookups, 0);
});

test('a stalled first node leaves time for fallback within the eight-second request budget', async () => {
  const keepAlive = setTimeout(() => {}, 5_000);
  const started = Date.now();
  const transport = createWeatherTransport({ lookup: async () => [{ address: '198.18.0.42' }],
    fetch: (async input => Response.json(answer(new URL(String(input)).hostname === 'dns.google'
      ? '167.114.211.86' : '51.81.167.44'))) as typeof fetch,
    direct: async (_url, address, init) => {
      if (address === '167.114.211.86') return Response.json({ ok: true });
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
    } });
  try {
    assert.deepEqual(await (await transport(target)).json(), { ok: true });
    assert.ok(Date.now() - started < 5_000);
  } finally { clearTimeout(keepAlive); }
});
