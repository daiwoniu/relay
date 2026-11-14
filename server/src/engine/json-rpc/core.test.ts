import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JsonRpcConnectionClosedError,
  JsonRpcCore,
  JsonRpcRemoteError,
  JsonRpcTimeoutError,
} from './core.js';
import type {
  JsonRpcEnvelope,
  JsonRpcTransport,
  JsonRpcTransportState,
} from '../transports/transport.js';

class FakeTransport implements JsonRpcTransport {
  state: JsonRpcTransportState = 'open';
  readonly sent: JsonRpcEnvelope[] = [];
  sendError: Error | null = null;
  private messageListeners = new Set<(message: JsonRpcEnvelope) => void>();
  private closeListeners = new Set<() => void>();

  send(message: JsonRpcEnvelope): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(message);
  }

  close(): void {
    this.state = 'closed';
    for (const listener of this.closeListeners) listener();
  }

  terminate(): void {
    this.close();
  }

  onOpen(): () => void {
    return () => undefined;
  }

  onMessage(listener: (message: JsonRpcEnvelope) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(): () => void {
    return () => undefined;
  }

  receive(message: JsonRpcEnvelope): void {
    for (const listener of this.messageListeners) listener(message);
  }
}

test('JSON-RPC 核心使用递增 ID 并支持并发乱序响应', async () => {
  const transport = new FakeTransport();
  const core = new JsonRpcCore(transport, { defaultTimeoutMs: 100 });

  const first = core.request('first', { value: 1 });
  const second = core.request('second', { value: 2 });
  assert.deepEqual(transport.sent, [
    { jsonrpc: '2.0', id: 1, method: 'first', params: { value: 1 } },
    { jsonrpc: '2.0', id: 2, method: 'second', params: { value: 2 } },
  ]);

  transport.receive({ jsonrpc: '2.0', id: 2, result: 'two' });
  transport.receive({ jsonrpc: '2.0', id: 1, result: 'one' });
  assert.equal(await first, 'one');
  assert.equal(await second, 'two');
});

test('JSON-RPC 核心保留显式 null 结果并允许请求关闭固定超时', async () => {
  const transport = new FakeTransport();
  const core = new JsonRpcCore(transport, { defaultTimeoutMs: 10 });

  const nullResult = core.request('nullable');
  transport.receive({ jsonrpc: '2.0', id: 1, result: null });
  assert.equal(await nullResult, null);

  const longRunning = core.request('long-running', {}, { timeoutMs: null });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(core.pendingCount, 1);
  transport.receive({ jsonrpc: '2.0', id: 2, result: { done: true } });
  assert.deepEqual(await longRunning, { done: true });
});

test('JSON-RPC 核心区分服务端请求、通知和同 ID response', async () => {
  const transport = new FakeTransport();
  const core = new JsonRpcCore(transport, { defaultTimeoutMs: 100 });
  const serverRequests: JsonRpcEnvelope[] = [];
  const notifications: JsonRpcEnvelope[] = [];
  core.onServerRequest((message) => serverRequests.push(message));
  core.onNotification((message) => notifications.push(message));

  const response = core.request('client/request');
  transport.receive({ jsonrpc: '2.0', id: 1, method: 'server/request', params: { ask: true } });
  transport.receive({ jsonrpc: '2.0', method: 'server/notification', params: { ready: true } });
  transport.receive({ jsonrpc: '2.0', id: 1, result: 'done' });

  assert.equal(await response, 'done');
  assert.equal(serverRequests[0]?.method, 'server/request');
  assert.equal(notifications[0]?.method, 'server/notification');
});

test('JSON-RPC 核心映射远端错误、超时和发送失败', async () => {
  const transport = new FakeTransport();
  const core = new JsonRpcCore(transport, { defaultTimeoutMs: 20 });
  const remote = core.request('remote/error');
  transport.receive({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32001, message: 'overloaded', data: { retryAfterMs: 10 } },
  });
  await assert.rejects(remote, (error: JsonRpcRemoteError) => (
    error instanceof JsonRpcRemoteError
    && error.rpcCode === -32001
    && error.rpcData?.retryAfterMs === 10
  ));

  await assert.rejects(core.request('slow'), JsonRpcTimeoutError);
  transport.sendError = new Error('send failed');
  await assert.rejects(core.request('send/failure'), /send failed/);
  assert.equal(core.pendingCount, 0);
});

test('JSON-RPC 核心在连接关闭时拒绝全部 pending 并支持响应发送', async () => {
  const transport = new FakeTransport();
  const core = new JsonRpcCore(transport, { defaultTimeoutMs: 100 });
  const pending = core.request('pending');
  core.respond(7, { accepted: true });
  core.respondError(8, -32601, 'not supported');
  core.notify('initialized', {});
  transport.close();

  await assert.rejects(pending, JsonRpcConnectionClosedError);
  assert.deepEqual(transport.sent.slice(1), [
    { jsonrpc: '2.0', id: 7, result: { accepted: true } },
    { jsonrpc: '2.0', id: 8, error: { code: -32601, message: 'not supported' } },
    { jsonrpc: '2.0', method: 'initialized', params: {} },
  ]);
  assert.equal(core.pendingCount, 0);
});
