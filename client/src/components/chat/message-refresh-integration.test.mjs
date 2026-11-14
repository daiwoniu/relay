import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const chatView = readFileSync(new URL('./ChatView.tsx', import.meta.url), 'utf8');
const relayWebSocket = readFileSync(new URL('../../hooks/useRelayWebSocket.ts', import.meta.url), 'utf8');

test('打开已有缓存的会话仍会请求最新消息', () => {
  assert.match(chatView, /const generation = \+\+messageRefreshGenerationRef\.current/);
  assert.match(chatView, /loadMessageRegion\(\{/);
  assert.match(chatView, /getMessagePage\(sessionId/);
  assert.match(chatView, /knownRevision/);
  assert.doesNotMatch(chatView, /activeSessionId && !messages\[activeSessionId\]/);
  assert.match(chatView, /signal:\s*controller\.signal/);
  assert.match(chatView, /timeoutMs:/);
});

test('稀疏或 dirty 消息缓存不携带 knownRevision，避免误走 unchanged', () => {
  assert.match(chatView, /initialRegion && !initialRegion\.dirty && initialRegion\.cacheSource !== 'none'/);
  assert.match(chatView, /\? initialRegion\.revision\s*:\s*null/);
});

test('打开已删除会话收到 404 时从侧栏移除并提示', () => {
  assert.match(chatView, /error\.status === 404[\s\S]*removeSession\(sessionId\)/);
  assert.match(chatView, /会话已删除/);
});

test('REST 与 WebSocket 快照都按消息 ID 合并而不是覆盖', () => {
assert.match(chatView, /mergeMessages\(sessionId, page\.messages\.map/);
  assert.match(relayWebSocket, /store\.applyMessageSync\([\s\S]*msg\.messageRevision,[\s\S]*msg\.messageNextCursor/);
  assert.doesNotMatch(relayWebSocket, /store\.setMessages\(msg\.sessionId, msg\.messages\)/);
});
