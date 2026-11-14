import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { createCodexConnection, type CodexConnection } from './client.js';
import { startRuntimeDiagnostics, stopRuntimeDiagnostics, RUNTIME_DIAGNOSTICS_CHANNEL } from '../system/runtime-diagnostics.js';

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待连接诊断超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('连接成功后 WebSocket 再出错也发送诊断，连接阶段仍只统计一次', async (t) => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const sendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
  const connectedDescriptor = Object.getOwnPropertyDescriptor(process, 'connected');
  const diagnostics: Record<string, any>[] = [];
  let connection: CodexConnection | undefined;
  t.after(async () => {
    stopRuntimeDiagnostics();
    connection?.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (sendDescriptor) Object.defineProperty(process, 'send', sendDescriptor);
    else Reflect.deleteProperty(process, 'send');
    if (connectedDescriptor) Object.defineProperty(process, 'connected', connectedDescriptor);
    else Reflect.deleteProperty(process, 'connected');
  });
  Object.defineProperty(process, 'connected', { configurable: true, value: true });
  Object.defineProperty(process, 'send', { configurable: true, value: (message: Record<string, unknown>, callback: () => void) => {
    diagnostics.push(message);
    callback();
    return true;
  } });
  startRuntimeDiagnostics();
  let peer: WebSocket | undefined;
  server.on('connection', (socket) => {
    peer = socket;
    socket.on('error', () => {});
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.id !== undefined) socket.send(JSON.stringify({ id: request.id, result: {} }));
    });
  });
  const stages: string[] = [];
  const events: string[] = [];
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  connection = createCodexConnection((event) => { if (event.type === 'error') events.push(event.code ?? ''); }, {
    wsUrl: `ws://127.0.0.1:${address.port}`,
    rpcTimeoutMs: 500,
    onHandshakeStage: (event) => { if (event.stage === 'connection') stages.push(event.outcome); },
  });
  await waitFor(() => !!peer && stages.includes('completed'));
  // A text frame containing invalid UTF-8 produces a real ws error after open.
  (peer as any)._socket.write(Buffer.from([0x81, 0x01, 0xff]));
  await waitFor(() => events.includes('CODEX_CONNECTION_ERROR'));
  assert.deepEqual(stages, ['completed']);
  assert.ok(diagnostics.some((message) => message.channel === RUNTIME_DIAGNOSTICS_CHANNEL
    && message.type === 'fault' && message.code === 'CODEX_CONNECTION_ERROR'));
});
