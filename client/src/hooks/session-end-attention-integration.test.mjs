import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('WebSocket 在覆盖会话状态前判断实时终态转换', () => {
  const source = fs.readFileSync(new URL('useRelayWebSocket.ts', import.meta.url), 'utf8');
  const previousIndex = source.indexOf('const previousSession = useChatStore.getState().sessions.find');
  const publishIndex = source.indexOf('useSessionEndAttentionStore.getState().publish(attentionEvent)');
  const upsertIndex = source.indexOf('useChatStore.getState().upsertSession({ ...msg.session, id: msg.sessionId })');
  assert.ok(previousIndex > 0);
  assert.ok(previousIndex < publishIndex);
  assert.ok(publishIndex < upsertIndex);
  assert.match(source, /snapshot: msg\.snapshot, previousResultMessageId: previousSession\?\.last_result\?\.messageId/);
});

test('授权与会话结束提醒均经过设备级多标签页协调', () => {
  const sessionHook = fs.readFileSync(new URL('useSessionEndAttention.ts', import.meta.url), 'utf8');
  const approvalHook = fs.readFileSync(new URL('useApprovalAttention.ts', import.meta.url), 'utf8');
  assert.match(sessionHook, /coordinateDeviceAttention/);
  assert.match(approvalHook, /coordinateDeviceAttention/);
});
