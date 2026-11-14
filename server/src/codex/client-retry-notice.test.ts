import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createCodexConnection } from './client.js';
import { presentRetryNotice } from './client-retry-notice.js';
import type { RelayWSMessage } from './protocol.js';
import { compactProcessItemsForStorage } from '../messages/storage.js';

test('重试提示保留次数和退避时间，不泄露上游错误详情', () => {
  const notice = presentRetryNotice({ error: {
    message: 'stream disconnected - retrying sampling request (2/5 in 1.5s)...',
    additionalDetails: 'private-provider-details',
  } }, 3);
  assert.match(notice.title, /模型连接中断.*第 3 次/);
  assert.match(notice.message!, /2\/5.*1500 毫秒/);
  assert.equal(notice.details?.kind, 'engine_retry');
  const [stored] = compactProcessItemsForStorage([{
    id: 'retry:1', type: 'systemNotice', status: 'completed',
    details: { ...notice.details, title: notice.title, message: notice.message, noticeType: notice.noticeType },
  }]);
  assert.equal(stored.details.kind, 'engine_retry');
  assert.equal(stored.details.message, notice.message);
  assert.equal(stored.details.title, notice.title);
  assert.doesNotMatch(JSON.stringify(notice), /private-provider-details/);
  assert.match(presentRetryNotice({ error: { message: 'Reconnecting... 1/5' } }, 1).message!, /1\/5/);
  assert.match(presentRetryNotice({}, 1).title, /模型请求暂时异常/);
});

test('上游重试逐次可见，隔离其他线程和旧回合，完成仍由真实终态决定', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const events: RelayWSMessage[] = [];
  let peer: any;
  server.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'initialized') return;
    if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
    if (message.method === 'config/read') socket.send(JSON.stringify({ id: message.id, result: { config: { model: 'test' } } }));
    if (message.method === 'thread/start') socket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'root' } } }));
    if (message.method === 'turn/start') {
      peer = socket;
      socket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'active' } } }));
      socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'root', turn: { id: 'active' } } }));
    }
  }));
  const connection = createCodexConnection((event) => events.push(event), {
    wsUrl: `ws://127.0.0.1:${address.port}`,
  });
  t.after(() => connection.close());
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      assert(Date.now() < deadline, '等待协议事件超时');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  connection.send('test');
  await waitFor(() => events.some((event) => event.type === 'turn_start'));
  const notify = (params: any) => peer.send(JSON.stringify({ method: 'error', params }));
  const retry = { threadId: 'root', turnId: 'active', willRetry: true, error: { message: 'Reconnecting... 1/5' } };
  notify({ ...retry, threadId: 'child' });
  notify({ ...retry, turnId: 'old' });
  notify(retry);
  notify({ ...retry, error: { message: 'Reconnecting... 2/5' } });
  notify({ ...retry, willRetry: false });
  const notices = () => events.filter((event) => event.type === 'system_notice' && event.details?.kind === 'engine_retry');
  await waitFor(() => notices().length === 2);
  assert.match((notices()[1] as any).title, /第 2 次/);
  assert(!events.some((event) => ['error', 'turn_complete', 'message_complete'].includes(event.type)));
  peer.send(JSON.stringify({ method: 'item/completed', params: {
    threadId: 'root', turnId: 'active', item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'done' },
  } }));
  peer.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'root', turn: { id: 'active', status: 'completed' } } }));
  await waitFor(() => events.some((event) => event.type === 'message_complete'));
  assert.equal(events.filter((event) => event.type === 'message_complete').length, 1);
  assert.equal(notices().length, 2);
  connection.send('next');
  await waitFor(() => events.filter((event) => event.type === 'turn_start').length === 2);
  notify(retry);
  await waitFor(() => notices().length === 3);
  assert.match((notices()[2] as any).title, /第 1 次/);
});
