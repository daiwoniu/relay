import { WebSocket } from 'ws';
import { loginAndGetCookie } from './auth-client.mjs';

const baseUrl = process.env.RELAY_BASE_URL || 'http://127.0.0.1:9081';
const wsUrl = process.env.RELAY_WS_URL || 'ws://127.0.0.1:9081/ws';
const accessToken = process.env.RELAY_ACCESS_TOKEN || '';
const accessHeaders = accessToken ? { 'X-Relay-Token': accessToken } : {};
const expectedAutoTitle = '自动标题验证 检查 Relay 同步';
const manualTitle = '手动标题保持不变';

let sessionId;
let ws;
const sessionCookie = await loginAndGetCookie(baseUrl, accessHeaders);

function waitForMessage(predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('等待 WebSocket 消息超时'));
    }, timeoutMs);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    };
    ws.on('message', onMessage);
  });
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...accessHeaders, 'Content-Type': 'application/json', Cookie: sessionCookie, ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} 返回 ${response.status}`);
  return response.json();
}

try {
  const session = await request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: '新对话' }),
  });
  sessionId = session.id;

  ws = new WebSocket(wsUrl, { headers: { ...accessHeaders, Cookie: sessionCookie } });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
  await waitForMessage((message) => message.type === 'sync_state' && message.sessionId === sessionId);

  const autoTitleEvent = waitForMessage(
    (message) => message.type === 'session_updated' && message.sessionId === sessionId && message.session.title === expectedAutoTitle
  );
  ws.send(JSON.stringify({
    type: 'send',
    sessionId,
    messageId: `title-${Date.now()}`,
    content: '## 自动标题验证\n\n检查 **Relay** 同步',
  }));
  await autoTitleEvent;
  ws.send(JSON.stringify({ type: 'cancel', sessionId }));

  const afterAutoTitle = await request(`/api/sessions/${sessionId}`);
  if (afterAutoTitle.title !== expectedAutoTitle) {
    throw new Error(`自动标题不匹配：${afterAutoTitle.title}`);
  }

  await request(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: manualTitle }),
  });

  ws.send(JSON.stringify({
    type: 'send',
    sessionId,
    messageId: `title-second-${Date.now()}`,
    content: '这条消息不应该覆盖手动标题',
  }));
  await new Promise((resolve) => setTimeout(resolve, 750));
  ws.send(JSON.stringify({ type: 'cancel', sessionId }));

  const afterSecondMessage = await request(`/api/sessions/${sessionId}`);
  if (afterSecondMessage.title !== manualTitle) {
    throw new Error(`手动标题被覆盖：${afterSecondMessage.title}`);
  }

  console.log(JSON.stringify({
    autoTitle: afterAutoTitle.title,
    manualTitle: afterSecondMessage.title,
    manualTitlePreserved: true,
  }, null, 2));
} finally {
  ws?.close();
  if (sessionId) {
    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { ...accessHeaders, Cookie: sessionCookie },
    });
    if (!response.ok) {
      throw new Error(`清理测试会话失败：DELETE /api/sessions/${sessionId} 返回 ${response.status}`);
    }
  }
}
