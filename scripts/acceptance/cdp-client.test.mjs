import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { CdpClient, connectCdpClient } from './lib/cdp-client.mjs';

class FakeSocket extends EventEmitter {
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.emit('close'); }
}

test('CDP request ID 配对并分发事件', async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket, { timeoutMs: 100 });
  const events = [];
  client.on('Runtime.consoleAPICalled', (params) => events.push(params));
  const pending = client.request('Runtime.enable', { token: 'must-not-leak' });
  const [{ id }] = socket.sent;
  socket.emit('message', JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log' } }));
  socket.emit('message', JSON.stringify({ id, result: { ok: true } }));
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(events, [{ type: 'log' }]);
});

test('CDP 支持 flatten target session 的请求与事件隔离', async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket, { timeoutMs: 100 });
  const events = [];
  client.on('Page.loadEventFired', (params) => events.push(params), { sessionId: 'session-a' });
  const pending = client.request('Page.enable', {}, 'session-a');
  const sent = socket.sent[0];
  assert.equal(sent.sessionId, 'session-a');
  socket.emit('message', JSON.stringify({ id: sent.id, sessionId: 'session-a', result: {} }));
  await pending;
  socket.emit('message', JSON.stringify({ method: 'Page.loadEventFired', sessionId: 'session-b', params: { value: 1 } }));
  socket.emit('message', JSON.stringify({ method: 'Page.loadEventFired', sessionId: 'session-a', params: { value: 2 } }));
  assert.deepEqual(events, [{ value: 2 }]);
});

test('CDP 协议错误、超时和 socket 关闭均失败且不泄露参数', async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket, { timeoutMs: 10 });
  const failed = client.request('Runtime.evaluate', { expression: 'SECRET_EXPRESSION' });
  socket.emit('message', JSON.stringify({ id: socket.sent[0].id, error: { code: -1, message: 'bad' } }));
  await assert.rejects(failed, (error) => !error.message.includes('SECRET_EXPRESSION'));
  await assert.rejects(client.request('Page.enable'), /超时/);
  const closing = client.request('Network.enable');
  socket.emit('close');
  await assert.rejects(closing, /已关闭/);
});

test('close 优先请求 Browser.close', async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket, { timeoutMs: 100 });
  const closing = client.closeBrowser();
  assert.equal(socket.sent[0].method, 'Browser.close');
  socket.emit('message', JSON.stringify({ id: socket.sent[0].id, result: {} }));
  await closing;
});

test('CDP 连接拒绝远程地址和预期端口不一致', async () => {
  await assert.rejects(connectCdpClient('ws://example.com/devtools/browser/id'), /地址无效/);
  await assert.rejects(connectCdpClient('ws://127.0.0.1:43210/devtools/browser/id', { expectedPort: 43211 }), /地址无效/);
});
