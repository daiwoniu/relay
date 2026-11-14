import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loginAndGetCookie } from './auth-client.mjs';

const baseUrl = process.env.RELAY_BASE_URL || 'http://127.0.0.1:9181';
const wsUrl = process.env.RELAY_WS_URL || 'ws://127.0.0.1:9181/ws';
const accessToken = process.env.RELAY_ACCESS_TOKEN
  || readFileSync(path.resolve(import.meta.dirname, '..', 'data', 'access-token'), 'utf8').trim();
const verificationCode = `relay-${Date.now()}`;
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
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.json();
}

function waitForCompletion(ws, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('等待 AI 回复超时'));
    }, timeoutMs);

    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'error') {
        cleanup();
        reject(new Error(message.message));
      } else if (message.type === 'message_complete') {
        cleanup();
        resolve(message);
      }
    };

    const onClose = () => {
      cleanup();
      reject(new Error('Relay WebSocket 在回复完成前断开'));
    };

    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    }

    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

const projects = await requestJson('/api/projects');
const project = projects.find((item) => item.is_system) || projects[0];
if (!project) throw new Error('没有可用于验证的项目');

const session = await requestJson('/api/sessions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: '连续会话自动验证', projectId: project.id }),
});

async function openSocket() {
  const socket = new WebSocket(wsUrl, { headers: { ...accessHeaders, Cookie: sessionCookie } });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

let ws = await openSocket();

try {
  ws.send(JSON.stringify({
    type: 'send',
    sessionId: session.id,
    content: `请记住验证码 ${verificationCode}，只回复“已记住”。`,
  }));
  await waitForCompletion(ws);

  const publicSession = await requestJson(`/api/sessions/${session.id}`);
  if (Object.hasOwn(publicSession, 'codex_thread_id')) {
    throw new Error('公共 SessionDto 不应暴露 codex_thread_id');
  }

  ws.close();
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  ws = await openSocket();

  ws.send(JSON.stringify({
    type: 'send',
    sessionId: session.id,
    content: '我刚才让你记住的验证码是什么？只回复验证码。',
  }));
  const secondReply = await waitForCompletion(ws);

  if (!secondReply.content.includes(verificationCode)) {
    throw new Error(`第二轮未回忆验证码，实际回复：${secondReply.content}`);
  }

  console.log(JSON.stringify({
    ok: true,
    sessionId: session.id,
    verificationCode,
    reconnectedAfterRuntimeCleanup: true,
    secondReply: secondReply.content,
  }, null, 2));
} finally {
  ws.close();
  await fetch(`${baseUrl}/api/sessions/${session.id}`, {
    method: 'DELETE',
    headers: { ...accessHeaders, Cookie: sessionCookie },
  }).catch(() => undefined);
}
