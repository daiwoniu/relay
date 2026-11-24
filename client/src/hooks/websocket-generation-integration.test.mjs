import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./useRelayWebSocket.ts', import.meta.url), 'utf8');
const chatStore = await readFile(new URL('../stores/chat.ts', import.meta.url), 'utf8');

test('每条 WebSocket 回调只处理当前连接代际', () => {
  assert.match(source, /connectionGenerationRef/);
  assert.match(source, /const isCurrentConnection = \(\) => isCurrentWebSocketConnection/);
  for (const handler of ['onopen', 'onmessage', 'onclose', 'onerror']) {
    assert.match(source, new RegExp(`ws\\.${handler} = .*?\\{\\n\\s+if \\(!isCurrentConnection\\(\\)\\) return;`, 's'));
  }
});

test('主动重连和卸载统一先退休旧连接', () => {
  assert.match(source, /const retireCurrentConnection = useCallback/);
  assert.match(source, /wsRef\.current = null;\s+connectionGenerationRef\.current \+= 1;/);
  assert.doesNotMatch(source, /manualReconnectRef/);
  assert.match(source, /retireCurrentConnection\(\);\s+connect\(\);/);
});

test('后续 WebSocket 协议握手增量合并会话快照且首次连接不重复请求', () => {
  assert.match(source, /hasCompletedProtocolHandshakeRef/);
  assert.match(source, /refreshSessionsAfterReconnect/);
  assert.match(source, /storeRef\.current\.mergeReconnectSessionSnapshot/);
  assert.match(source, /hasCompletedProtocolHandshakeRef\.current = true/);
  assert.match(chatStore, /mergeReconnectSessionSnapshot:/);
});

test('重连使用同一取消信号加载会话和排序，保留列表中仍可访问的会话', () => {
  assert.match(source, /Promise\.all\(\[listSessions\(controller\.signal\), listSidebarOrders\(controller\.signal\)\]\)/);
  assert.match(source, /ws\.addEventListener\('close', abort, \{ once: true \}\)/);
  assert.match(source, /for \(const session of sessions\) inventory\.sessionIds\.add\(session\.id\)/);
  assert.match(source, /findMissingResourceIds/);
  assert.match(source, /for \(const projectId of missing\.projectIds\).*removeProject/);
  assert.match(source, /for \(const sessionId of missing\.sessionIds\).*removeSession/);
});

test('跨端删除当前资源时提示，本机删除广播只同步状态', () => {
  assert.match(source, /msg\.type === 'project_deleted'[\s\S]*consumeLocalResourceDeletion\('project'/);
  assert.match(source, /msg\.type === 'session_deleted'[\s\S]*consumeLocalResourceDeletion\('session'/);
  assert.match(source, /affectsCurrent && !localDeletion/);
  assert.match(source, /会话已在其他终端删除/);
  assert.match(source, /项目已在其他终端删除/);
});
