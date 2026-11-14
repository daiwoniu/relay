import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('会话消息接口禁止浏览器和代理缓存私有消息', () => {
  const source = fs.readFileSync(new URL('sessions.ts', import.meta.url), 'utf8');
  const messagesRoute = source.slice(source.indexOf("sessions.get('/:id/messages'"));
  assert.match(messagesRoute, /c\.header\('Cache-Control', 'private, no-store'\)/);
  assert.match(messagesRoute, /c\.req\.query\('details'\) !== '0'/);
  const messagePageRoute = source.slice(source.indexOf("sessions.get('/:id/message-page'"), source.indexOf("sessions.get('/:id/messages'"));
  assert.match(messagePageRoute, /c\.header\('Cache-Control', 'private, no-store'\)/);
  assert.match(messagePageRoute, /beforeCreatedAt/);
  assert.match(messagePageRoute, /beforeId/);
});
