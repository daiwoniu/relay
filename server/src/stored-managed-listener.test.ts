import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { WebSocket } from 'ws';
import { createServer, type AddressInfo } from 'node:net';

test('isolated managed listener enforces access token and Origin before upgrade and joins application close', async () => {
  process.env.RELAY_ACCESS_TOKEN = 'synthetic-managed-listener';
  const { listenStoredManagedApplication } = await import('./stored-managed-listener.js');
  let status = 'prepared', closed = false, upgrades = 0;
  const app = new Hono(); app.get('/api/health', c => c.json({ status }, status === 'ready' ? 200 : 503));
  const listener = await listenStoredManagedApplication({ app, get status() { return status; }, activate: async () => { status = 'ready'; },
    attachFrontend: wss => { wss.on('connection', socket => { upgrades++; socket.close(); }); }, close: async () => { closed = true; status = 'closed'; } }, { hostname: '127.0.0.1', port: 0 });
  const port = (listener.address as AddressInfo).port;
  const denied = (token: string, origin: string) => new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`, { origin });
    socket.on('unexpected-response', (request, response) => { resolve(response.statusCode!); request.destroy(); response.destroy(); });
    socket.on('error', reject); socket.on('open', () => { socket.terminate(); reject(Error('unexpected upgrade')); });
  });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
    assert.equal(await denied('wrong', 'http://localhost'), 401);
    assert.equal(await denied('synthetic-managed-listener', 'https://untrusted.invalid'), 403);
    assert.equal(upgrades, 0);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=synthetic-managed-listener`, { origin: 'http://localhost' });
      socket.on('error', reject); socket.on('close', () => resolve());
    });
    assert.equal(upgrades, 1);
  } finally { await listener.close(); }
  assert.equal(closed, true); assert.equal(listener.server.listening, false);
});

test('occupied isolated port or activation failure closes only the newly prepared application', async () => {
  process.env.RELAY_ACCESS_TOKEN = 'synthetic-managed-listener';
  const { listenStoredManagedApplication } = await import('./stored-managed-listener.js');
  const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  let closes = 0, activations = 0;
  const application = { app: new Hono(), status: 'prepared', attachFrontend: () => undefined,
    activate: async () => { activations++; throw Error('synthetic activation failure'); }, close: async () => { closes++; } };
  try {
    await assert.rejects(listenStoredManagedApplication(application, { hostname: '127.0.0.1', port: (occupied.address() as AddressInfo).port }), { code: 'EADDRINUSE' });
    assert.equal(occupied.listening, true); assert.equal(activations, 0); assert.equal(closes, 1);
    await assert.rejects(listenStoredManagedApplication(application, { hostname: '127.0.0.1', port: 0 }), /synthetic activation failure/);
    assert.equal(activations, 1); assert.equal(closes, 2);
  } finally { await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve())); }
});
