import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./useRelayWebSocket.ts', import.meta.url), 'utf8');

function sourceBetween(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `缺少起始标记：${start}`);
  assert.notEqual(endIndex, -1, `缺少结束标记：${end}`);
  return source.slice(startIndex, endIndex);
}

test('临时断线和主动重连不会拒绝仍可核实的消息发送', () => {
  const closeHandler = sourceBetween('ws.onclose =', 'ws.onerror =');
  const reconnect = sourceBetween('const reconnect = useCallback', 'const resyncSession = useCallback');

  assert.doesNotMatch(closeHandler, /pendingSendManagerRef\.current\.rejectAll/);
  assert.doesNotMatch(reconnect, /pendingSendManagerRef\.current\.rejectAll/);
});

test('重连同步页按消息 ID 补做发送确认', () => {
  const syncState = sourceBetween("case 'sync_state':", "case 'request_forwarded':");
  assert.match(syncState, /msg\.messages[\s\S]*pendingSendManagerRef\.current\.confirm/);
});

test('确认超时查询消息详情和后续队列，暂时缺失时请求权威快照', () => {
  assert.match(source, /getMessageDetails\(sessionId, messageId, \{ timeoutMs: 3_000 \}\)/);
  assert.match(source, /verifyPendingSend\(\{/);
  assert.match(source, /hasFollowup:[\s\S]*bySession\[sessionId\]/);
  assert.match(source, /requestSync:[\s\S]*sendSubscribeCommand\(ws, sessionId/);
});

test('Hook 真正卸载时仍释放全部待确认发送', () => {
  const cleanup = sourceBetween(
    'useEffect(() => {\n    disposedRef.current = false;',
    '}, [connect, retireCurrentConnection]);',
  );
  assert.match(cleanup, /pendingSendManagerRef\.current\.rejectAll/);
});
