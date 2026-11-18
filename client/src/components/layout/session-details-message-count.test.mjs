import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('会话详情展示服务端消息数量并为旧服务端保留未知态', () => {
  const source = fs.readFileSync(new URL('SessionDetailsContent.tsx', import.meta.url), 'utf8');

  assert.match(source, /const messageCount = session\.message_count === undefined \? '—' : `\$\{session\.message_count\} 条`/);
  assert.match(source, /消息数量：\{messageCount\}/);
  assert.match(source, /const assistantMessageCount = session\.assistant_message_count === undefined \? '—' : `\$\{session\.assistant_message_count\} 条`/);
  assert.match(source, /消息数量：\{messageCount\} · 助手：\{assistantMessageCount\}<\/div>/);
});
