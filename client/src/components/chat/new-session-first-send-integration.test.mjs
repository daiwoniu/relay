import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./ChatView.tsx', import.meta.url), 'utf8');

test('新会话首次发送确认前不切换活动会话', () => {
  const handleSend = source.slice(
    source.indexOf('const handleSend = async'),
    source.indexOf('const currentMessages ='),
  );
  const createIndex = handleSend.indexOf('await createSession(');
  const settleIndex = handleSend.indexOf('settleCreatedSessionFirstSend(');

  assert.ok(createIndex >= 0);
  assert.ok(settleIndex > createIndex);
  assert.doesNotMatch(handleSend.slice(createIndex, settleIndex), /setActiveSession\(/);
  assert.match(handleSend.slice(settleIndex), /onAccepted:[\s\S]*?useChatStore\.getState\(\)[\s\S]*?shouldAutoActivateCreatedSession\([\s\S]*?setActiveSession\(targetSessionId\)/);
});

test('仅在消息权威缺失时删除首次发送创建的空会话', () => {
  const handleSend = source.slice(
    source.indexOf('const handleSend = async'),
    source.indexOf('const currentMessages ='),
  );

  assert.match(handleSend, /getMessageDetails\(targetSessionId, messageId/);
  assert.match(handleSend, /error instanceof ApiError && error\.status === 404[\s\S]*?'missing'/);
  assert.match(handleSend, /discard:[\s\S]*?await deleteSession\(targetSessionId\)[\s\S]*?removeSession\(targetSessionId\)/);
});
