import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { readCodexRunningVersion } from './running-version.js';

test('运行版本只取实际握手标识，不创建会话；非法或缺失标识返回未知', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  let userAgent: string | undefined = 'relay/0.171.0 (Windows; x86_64)';
  const methods: string[] = [];
  server.on('connection', socket => socket.on('message', raw => {
    const request = JSON.parse(raw.toString());
    methods.push(request.method);
    if (request.method === 'initialize') socket.send(JSON.stringify({ id: request.id, result: { userAgent } }));
  }));
  const options = { wsUrl: `ws://127.0.0.1:${address.port}` };
  assert.equal(await readCodexRunningVersion(options), '0.171.0');
  userAgent = 'some-provider/9.0.0';
  assert.equal(await readCodexRunningVersion(options), null);
  userAgent = undefined;
  assert.equal(await readCodexRunningVersion(options), null);
  assert(methods.every(method => method === 'initialize' || method === 'initialized'));
});

test('握手无响应或连接提前关闭时有界返回未知', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  let close = false;
  server.on('connection', socket => { if (close) socket.close(); });
  const options = { wsUrl: `ws://127.0.0.1:${address.port}`, timeoutMs: 50 };
  assert.equal(await readCodexRunningVersion(options), null);
  close = true;
  assert.equal(await readCodexRunningVersion(options), null);
});
