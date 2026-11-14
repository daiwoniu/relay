import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loginAndGetCookie } from './auth-client.mjs';

const baseUrl = process.env.RELAY_BASE_URL || 'http://127.0.0.1:9181';
const wsUrl = process.env.RELAY_WS_URL || 'ws://127.0.0.1:9181/ws';
const accessToken = process.env.RELAY_ACCESS_TOKEN
  || readFileSync(path.resolve(import.meta.dirname, '..', 'data', 'access-token'), 'utf8').trim();
const syncCode = `sync-${Date.now()}`;
const accessHeaders = accessToken ? { 'X-Relay-Token': accessToken } : {};
const sessionCookie = await loginAndGetCookie(baseUrl, accessHeaders);

async function requestJson(path, options) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options?.headers || {}),
      ...accessHeaders,
      Cookie: sessionCookie,
    },
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json();
}

async function openSocket() {
  const ws = new WebSocket(wsUrl, { headers: { ...accessHeaders, Cookie: sessionCookie } });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

function createInbox(ws) {
  const queue = [];
  const waiters = [];

  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      queue.push(message);
    }
  });

  return {
    wait(predicate, timeoutMs = 180_000) {
      const existingIndex = queue.findIndex(predicate);
      if (existingIndex >= 0) return Promise.resolve(queue.splice(existingIndex, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('等待多端同步事件超时'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

const projects = await requestJson('/api/projects');
const project = projects.find((item) => item.is_system) || projects[0];
if (!project) throw new Error('没有可用于验证的项目');

const session = await requestJson('/api/sessions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: '多端同步自动验证', projectId: project.id }),
});

const wsA = await openSocket();
const wsB = await openSocket();
const inboxA = createInbox(wsA);
const inboxB = createInbox(wsB);

try {
  wsA.send(JSON.stringify({ type: 'subscribe', sessionId: session.id }));
  wsB.send(JSON.stringify({ type: 'subscribe', sessionId: session.id }));
  await Promise.all([
    inboxA.wait((message) => message.type === 'sync_state' && message.sessionId === session.id),
    inboxB.wait((message) => message.type === 'sync_state' && message.sessionId === session.id),
  ]);

  const messageId = `verify-${Date.now()}`;
  wsA.send(JSON.stringify({
    type: 'send',
    sessionId: session.id,
    messageId,
    content: `只回复同步码 ${syncCode}`,
  }));

  const userSaved = (message) => message.type === 'message_saved'
    && message.sessionId === session.id
    && message.message?.id === messageId;
  await Promise.all([inboxA.wait(userSaved), inboxB.wait(userSaved)]);
  await inboxB.wait((message) => message.type === 'turn_start' && message.sessionId === session.id);

  // 发起端断开后，订阅端仍应继续收到完整任务流。
  wsA.close();

  const completed = await inboxB.wait((message) => message.type === 'message_complete' && message.sessionId === session.id);
  const assistantSaved = await inboxB.wait((message) => message.type === 'message_saved'
    && message.sessionId === session.id
    && message.message?.role === 'assistant');

  if (!completed.content.includes(syncCode)) {
    throw new Error(`订阅端收到的完成内容不含同步码：${completed.content}`);
  }
  if (!assistantSaved.message.content.includes(syncCode)) {
    throw new Error(`订阅端收到的持久化消息不含同步码：${assistantSaved.message.content}`);
  }

  const messages = await requestJson(`/api/sessions/${session.id}/messages`);
  if (messages.filter((message) => message.id === messageId).length !== 1) {
    throw new Error('用户消息未按客户端 messageId 去重持久化');
  }
  if (messages.filter((message) => message.role === 'assistant').length !== 1) {
    throw new Error('assistant 消息持久化数量异常');
  }

  const wsC = await openSocket();
  const inboxC = createInbox(wsC);
  wsC.send(JSON.stringify({ type: 'subscribe', sessionId: session.id }));
  const snapshot = await inboxC.wait((message) => message.type === 'sync_state' && message.sessionId === session.id);
  wsC.close();
  if (snapshot.isRunning || snapshot.messages.length !== 2) {
    throw new Error('新订阅端没有收到完成后的权威消息快照');
  }

  console.log(JSON.stringify({
    ok: true,
    sessionId: session.id,
    syncCode,
    initiatingClientDisconnected: true,
    snapshotMessageCount: snapshot.messages.length,
    subscriberReply: assistantSaved.message.content,
  }, null, 2));
} finally {
  wsA.close();
  wsB.close();
  await fetch(`${baseUrl}/api/sessions/${session.id}`, {
    method: 'DELETE',
    headers: { ...accessHeaders, Cookie: sessionCookie },
  }).catch(() => undefined);
}
