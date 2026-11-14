import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { WebSocketJsonRpcTransport, WebSocketTransportParseError } from './websocket.js';

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待 WebSocket transport 条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('WebSocket transport 发送和解析 JSON-RPC 信封', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const received: any[] = [];
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      received.push(JSON.parse(data.toString()));
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }));
    });
  });

  const transport = new WebSocketJsonRpcTransport(`ws://127.0.0.1:${address.port}`);
  t.after(() => transport.close());
  const messages: any[] = [];
  transport.onMessage((message) => messages.push(message));
  await new Promise<void>((resolve) => transport.onOpen(resolve));
  transport.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });
  await waitFor(() => messages.length === 1);

  assert.equal(transport.state, 'open');
  assert.equal(received[0].method, 'ping');
  assert.equal(messages[0].result, 'ok');
});

test('WebSocket transport 将非法 JSON 映射为解析错误并报告关闭', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  server.on('connection', (socket) => socket.send('not-json'));

  const transport = new WebSocketJsonRpcTransport(`ws://127.0.0.1:${address.port}`);
  const errors: Error[] = [];
  let closed = false;
  transport.onError((error) => errors.push(error));
  transport.onClose(() => { closed = true; });
  await waitFor(() => errors.length > 0);
  assert.ok(errors[0] instanceof WebSocketTransportParseError);
  transport.close();
  await waitFor(() => closed);
  assert.equal(transport.state, 'closed');
});

test('WebSocket physical close completes before owned runtime shutdown releases its lease',async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert(address&&typeof address==='object');
  const transport=new WebSocketJsonRpcTransport(`ws://127.0.0.1:${address.port}`);let closed=false;
  transport.onClose(()=>{closed=true;});
  try{
    await new Promise<void>(resolve=>transport.onOpen(resolve));await transport.closeAndWait();
    assert.equal(closed,true);assert.equal(transport.state,'closed');await transport.closeAndWait();
  }finally{transport.terminate();for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
