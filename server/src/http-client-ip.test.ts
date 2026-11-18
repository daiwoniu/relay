import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { getHttpClientIp } from './http-client-ip.js';
import { resolveWebSocketClientIp } from './message-origin.js';

test('HTTP与WebSocket共享内部来源规则，旧环境开关不能放开原始XFF信任', async () => {
  const previous = process.env.RELAY_TRUST_PROXY;
  process.env.RELAY_TRUST_PROXY = '1';
  try {
    for (const peer of [undefined, '192.168.1.8', '127.0.0.1', '::1']) {
      const app = new Hono();
      app.get('/', c => c.json({ ip: getHttpClientIp(c, peer) }));
      const response = await app.request('/', { headers: { 'x-relay-client-address': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' } });
      const wsIp = resolveWebSocketClientIp({ remoteAddress: peer, relayClientAddress: '203.0.113.9' });
      assert.equal((await response.json()).ip, wsIp);
    }
    const app = new Hono(); app.get('/', c => c.text(getHttpClientIp(c, '127.0.0.1')));
    assert.equal(await (await app.request('/', { headers: { 'x-forwarded-for': '203.0.113.9' } })).text(), '127.0.0.1');
  } finally {
    if (previous === undefined) delete process.env.RELAY_TRUST_PROXY; else process.env.RELAY_TRUST_PROXY = previous;
  }
});
