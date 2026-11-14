import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { createCodexAccountReader, openCodexAccountRpcClient } from './codex-account-reader.js';

test('account RPC treats malformed JSON and disconnected pending calls as failures and joins socket closure', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  server.on('connection', socket => socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
    if (message.method === 'malformed') socket.send('{broken');
    if (message.method === 'disconnect') socket.terminate();
  }));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const method of ['malformed', 'disconnect']) {
      const client = await openCodexAccountRpcClient({ url, timeoutMs: 1000 });
      try {
        await assert.rejects(client.request(method), /CODEX_ACCOUNT_RPC_UNAVAILABLE/);
        await assert.rejects(client.request('late'), /CODEX_ACCOUNT_RPC_UNAVAILABLE/);
      } finally { await client.close(); }
    }
  } finally { for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('account RPC initialization deadline disposes the actual socket', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  let connectionClosed!: () => void;
  const closed = new Promise<void>(resolve => { connectionClosed = resolve; });
  server.on('connection', socket => socket.once('close', connectionClosed));
  try {
    await assert.rejects(openCodexAccountRpcClient({ url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 500 }), /CODEX_ACCOUNT_RPC_TIMEOUT/);
    await closed;
  } finally { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('account inspection retains its lifecycle hold until asynchronous RPC close actually finishes', async () => {
  let release!: () => void, entered!: () => void, released = false;
  const closed = new Promise<void>(resolve => { release = resolve; });
  const closing = new Promise<void>(resolve => { entered = resolve; });
  const reader = createCodexAccountReader({ ensureReady: async () => true, releaseReady: () => { released = true; },
    openRpc: async () => ({ request: async () => ({}), close: async () => { entered(); await closed; } }) });
  const pending = reader.readSnapshot();
  try { await closing; assert.equal(released, false); release(); await pending; assert.equal(released, true); }
  finally { release(); await pending; }
});
